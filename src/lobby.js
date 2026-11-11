/*
 * One Durable Object per lobby.
 *
 * Uses the WebSocket Hibernation API, so the object can be evicted from memory
 * between messages. Anything that must survive lives in storage (the lobby) or
 * in each socket's attachment ({ lobbyId, create, playerId }); `this.lobby` is
 * only a cache reloaded in the constructor.
 *
 * One alarm does two jobs:
 *   - while a game is running and someone is connected, a periodic resync
 *     broadcast (clients interpolate the clock themselves between snapshots);
 *   - once nobody is connected, reaping the lobby LOBBY_TTL_MS after it was
 *     last touched.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  LOBBY_TTL_MS,
  MAX_PLAYERS_CAP,
  applyAction,
  cleanName,
  clampInt,
  clampTimeMs,
  createLobby,
  isRunning,
  makePlayer,
  serialize,
} from './game.js';

const RESYNC_MS = 30_000;

// Per-socket message limit: a token bucket that allows bursts of MSG_BURST
// and refills at MSG_PER_SEC. Kept in memory only, so it resets if the object
// hibernates, which is fine for stopping floods. A socket that keeps pushing
// past the limit is closed.
const MSG_BURST = 30;
const MSG_PER_SEC = 10;
const MSG_MAX_DROPS = 100;
const MSG_MAX_BYTES = 2048;

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lobby = null;
    this.buckets = new WeakMap(); // ws -> { tokens, at, drops }
    ctx.blockConcurrencyWhile(async () => {
      this.lobby = (await ctx.storage.get('lobby')) ?? null;
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      lobbyId: url.searchParams.get('lobby'),
      create: url.searchParams.get('create') === '1',
      playerId: null,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (!this.allow(ws)) return;
    if (typeof data !== 'string' || data.length > MSG_MAX_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && typeof msg.type === 'string') await this.handle(ws, msg);
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {}
    if (!this.lobby) return;
    await this.commit(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    if (!this.lobby) return;
    const anyone = this.playerSockets().length > 0;
    if (isRunning(this.lobby) && anyone) {
      this.broadcast();
      await this.schedule();
    } else if (!anyone && Date.now() >= this.lobby.touchedAt + LOBBY_TTL_MS) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.lobby = null;
    } else {
      await this.schedule();
    }
  }

  allow(ws) {
    const t = Date.now();
    let b = this.buckets.get(ws);
    if (!b) this.buckets.set(ws, (b = { tokens: MSG_BURST, at: t, drops: 0 }));
    b.tokens = Math.min(MSG_BURST, b.tokens + ((t - b.at) / 1000) * MSG_PER_SEC);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.drops = 0;
      return true;
    }
    if (++b.drops >= MSG_MAX_DROPS) {
      sendError(ws, 'Too many messages');
      try {
        ws.close(1008, 'rate limited');
      } catch {}
    }
    return false;
  }

  // -------------------------------------------------------------------------

  async handle(ws, msg) {
    const att = ws.deserializeAttachment();

    switch (msg.type) {
      case 'create': {
        if (!att.create || this.lobby) return sendError(ws, 'Could not create lobby, please try again');
        const { lobby, player } = createLobby(att.lobbyId, {
          hostName: msg.name,
          defaultTimeMs: clampTimeMs(msg.minutes) || 10 * 60_000,
          maxPlayers: clampInt(msg.maxPlayers, 2, MAX_PLAYERS_CAP, 6),
          incrementMs: clampInt(msg.incrementSeconds, 0, 600, 0) * 1000,
        });
        this.lobby = lobby;
        attach(ws, player);
        ws.send(JSON.stringify({ type: 'created', lobbyId: lobby.id, token: player.token, playerId: player.id }));
        await this.commit();
        return;
      }

      case 'hello': {
        // Never write for an unknown id: any random URL would create a lobby.
        const lobby = this.lobby;
        if (!lobby || String(msg.lobbyId || '') !== lobby.id) return sendError(ws, 'Lobby not found');

        let player = msg.token ? lobby.players.find((p) => p.token === msg.token) : null;
        if (!player) {
          if (lobby.started) return sendError(ws, 'That game has already started');
          if (lobby.players.length >= lobby.maxPlayers) return sendError(ws, 'This lobby is full');
          player = makePlayer(cleanName(msg.name) || `Player ${lobby.players.length + 1}`, lobby.defaultTimeMs);
          lobby.players.push(player);
        }
        attach(ws, player);
        ws.send(JSON.stringify({ type: 'joined', lobbyId: lobby.id, token: player.token, playerId: player.id }));
        await this.commit();
        return;
      }

      default: {
        const lobby = this.lobby;
        if (!lobby || !att.playerId) return;
        const me = lobby.players.find((p) => p.id === att.playerId);
        if (!me) return;
        const kicked = applyAction(lobby, me, me.id === lobby.hostPlayerId, msg);
        if (kicked) this.kick(kicked);
        await this.commit();
      }
    }
  }

  kick(playerId) {
    for (const s of this.playerSockets()) {
      if (s.deserializeAttachment().playerId !== playerId) continue;
      sendError(s, 'You were removed from the lobby');
      s.serializeAttachment({ ...s.deserializeAttachment(), playerId: null });
      try {
        s.close(4000, 'kicked');
      } catch {}
    }
  }

  // Persist, push the new state to everyone, and re-arm the alarm.
  // `closing` is a socket that is going away but may still be listed.
  async commit(closing) {
    this.lobby.touchedAt = Date.now();
    await this.ctx.storage.put('lobby', this.lobby);
    this.broadcast(closing);
    await this.schedule(closing);
  }

  async schedule(closing) {
    const lobby = this.lobby;
    if (this.playerSockets(closing).length === 0) {
      await this.ctx.storage.setAlarm(lobby.touchedAt + LOBBY_TTL_MS);
    } else if (isRunning(lobby)) {
      await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  broadcast(closing) {
    const sockets = this.playerSockets(closing);
    const connected = new Set(sockets.map((s) => s.deserializeAttachment().playerId));
    for (const ws of sockets) {
      try {
        ws.send(serialize(this.lobby, ws.deserializeAttachment().playerId, connected));
      } catch {}
    }
  }

  playerSockets(closing) {
    return this.ctx.getWebSockets().filter((s) => {
      if (s === closing || s.readyState !== WebSocket.OPEN) return false;
      return s.deserializeAttachment()?.playerId != null;
    });
  }
}

function attach(ws, player) {
  ws.serializeAttachment({ ...ws.deserializeAttachment(), playerId: player.id });
}

function sendError(ws, error) {
  try {
    ws.send(JSON.stringify({ type: 'error', error }));
  } catch {}
}
