/*
 * Pure game logic: lobby shape, timekeeping, and the action reducer.
 *
 * A lobby is plain JSON so it can be stored as-is in Durable Object storage.
 * Which players are connected is not part of it; the Lobby DO derives that
 * from its open WebSockets.
 *
 * The server is the single source of truth for time. Clients only interpolate
 * between snapshots for a smooth display; they never decide how much time is left.
 */

export const MIN_TIME_MS = 1_000;
export const MAX_TIME_MS = 24 * 60 * 60 * 1000;
export const MAX_PLAYERS_CAP = 16;
export const NAME_MAX = 24;
export const LOBBY_TTL_MS = 6 * 60 * 60 * 1000; // drop abandoned lobbies after 6h

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomB64 = () => base64url(crypto.getRandomValues(new Uint8Array(24)));

export const rid = (n = 8) => randomB64().slice(0, n);
export const newToken = () => randomB64();
const now = () => Date.now();

export function clampTimeMs(minutes) {
  const ms = Math.round(Number(minutes) * 60_000);
  if (!Number.isFinite(ms)) return null;
  return Math.min(MAX_TIME_MS, Math.max(MIN_TIME_MS, ms));
}
export function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
export function cleanName(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// `deviceId` is the id of the player whose socket controls this one. Each
// connected phone has one primary player (deviceId === id) plus any extra
// players added on it; a device's players always sit next to each other.
export function makePlayer(name, timeMs, deviceId) {
  const id = rid(8);
  return {
    id,
    token: newToken(),
    deviceId: deviceId || id,
    name: name || 'Player',
    baseTimeMs: timeMs, // configured starting time
    timeLeftMs: timeMs, // remaining as of turnStartedAt (or as of now when not running)
    customTime: false, // host set this player's time individually
    adjustMs: 0, // net host adjustment during the current pause, for display
  };
}

// Lobbies stored before devices existed have no deviceId.
export const deviceOf = (p) => p.deviceId || p.id;

// Split the turn order into contiguous per-device blocks.
function deviceGroups(players) {
  const groups = [];
  for (const p of players) {
    const last = groups[groups.length - 1];
    if (last && deviceOf(last[0]) === deviceOf(p)) last.push(p);
    else groups.push([p]);
  }
  return groups;
}

// Also unlocks resume, which the host's first adjustment locks to themselves.
function clearAdjustments(lobby) {
  for (const p of lobby.players) p.adjustMs = 0;
  lobby.resumeLocked = false;
}

export function createLobby(id, { hostName, defaultTimeMs, maxPlayers, incrementMs }) {
  const host = makePlayer(cleanName(hostName) || 'Host', defaultTimeMs);
  const lobby = {
    id,
    createdAt: now(),
    touchedAt: now(),
    hostPlayerId: host.id,
    started: false,
    paused: false,
    pausedById: null,
    resumeLocked: false, // host is adjusting times; only they may resume
    defaultTimeMs,
    maxPlayers,
    incrementMs,
    players: [host],
    currentIndex: 0,
    turnStartedAt: null, // ms timestamp the running segment began, or null
  };
  return { lobby, player: host };
}

// ---------------------------------------------------------------------------
// Timekeeping (server authoritative)
// ---------------------------------------------------------------------------

export function isRunning(lobby) {
  return lobby.started && !lobby.paused && lobby.turnStartedAt != null;
}

// Fold the elapsed running time into the current player's banked time and
// restart the segment clock. Safe to call at any moment.
export function bankCurrent(lobby) {
  if (!isRunning(lobby)) return;
  const p = lobby.players[lobby.currentIndex];
  if (p) {
    const elapsed = now() - lobby.turnStartedAt;
    p.timeLeftMs = Math.max(0, p.timeLeftMs - elapsed);
  }
  lobby.turnStartedAt = now();
}

export function startGame(lobby) {
  if (lobby.started || lobby.players.length < 2) return;
  for (const p of lobby.players) p.timeLeftMs = p.baseTimeMs;
  lobby.started = true;
  lobby.paused = false;
  lobby.pausedById = null;
  lobby.currentIndex = 0;
  lobby.turnStartedAt = now();
  clearAdjustments(lobby);
}

export function endTurn(lobby) {
  if (!lobby.started || lobby.paused) return;
  bankCurrent(lobby);
  const p = lobby.players[lobby.currentIndex];
  // Fischer increment: only credited if the player did not flag (hit zero).
  if (p && p.timeLeftMs > 0) p.timeLeftMs += lobby.incrementMs;
  lobby.currentIndex = (lobby.currentIndex + 1) % lobby.players.length;
  lobby.turnStartedAt = now();
}

export function pauseGame(lobby, byId) {
  if (!lobby.started || lobby.paused) return;
  bankCurrent(lobby);
  lobby.paused = true;
  lobby.pausedById = byId;
  lobby.turnStartedAt = null;
  clearAdjustments(lobby);
}

export function resumeGame(lobby) {
  if (!lobby.started || !lobby.paused) return;
  lobby.paused = false;
  lobby.pausedById = null;
  lobby.turnStartedAt = now();
  clearAdjustments(lobby);
}

export function resetGame(lobby) {
  lobby.started = false;
  lobby.paused = false;
  lobby.pausedById = null;
  lobby.currentIndex = 0;
  lobby.turnStartedAt = null;
  for (const p of lobby.players) p.timeLeftMs = p.baseTimeMs;
  clearAdjustments(lobby);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function nameOf(lobby, playerId) {
  const p = lobby.players.find((x) => x.id === playerId);
  return p ? p.name : null;
}

export function serialize(lobby, viewerId, connectedIds) {
  return JSON.stringify({
    type: 'state',
    serverNow: now(),
    you: {
      playerId: viewerId,
      isHost: viewerId === lobby.hostPlayerId,
    },
    lobby: {
      id: lobby.id,
      started: lobby.started,
      paused: lobby.paused,
      pausedByName: lobby.pausedById ? nameOf(lobby, lobby.pausedById) : null,
      resumeLocked: !!lobby.resumeLocked,
      defaultTimeMs: lobby.defaultTimeMs,
      maxPlayers: lobby.maxPlayers,
      incrementMs: lobby.incrementMs,
      currentIndex: lobby.currentIndex,
      turnStartedAt: lobby.turnStartedAt,
      hostPlayerId: lobby.hostPlayerId,
      players: lobby.players.map((p) => ({
        id: p.id,
        deviceId: deviceOf(p),
        name: p.name,
        baseTimeMs: p.baseTimeMs,
        timeLeftMs: p.timeLeftMs, // raw banked value; client interpolates the active one
        customTime: p.customTime,
        adjustMs: p.adjustMs || 0,
        connected: connectedIds.has(deviceOf(p)),
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// Actions from an attached player
// ---------------------------------------------------------------------------

// Mutates the lobby. Returns the id of a kicked device so the caller can close
// its sockets; otherwise returns undefined.
export function applyAction(lobby, me, isHost, msg) {
  const mine = (p) => p && deviceOf(p) === me.id;
  switch (msg.type) {
    // ---- anyone ----
    case 'setName': {
      // Any player on your own device; defaults to you.
      const p = msg.playerId ? lobby.players.find((x) => x.id === msg.playerId) : me;
      const n = cleanName(msg.name);
      if (n && mine(p)) p.name = n;
      return;
    }
    case 'addLocalPlayer': {
      if (lobby.started || lobby.players.length >= lobby.maxPlayers) return;
      const p = makePlayer(cleanName(msg.name) || `Player ${lobby.players.length + 1}`, lobby.defaultTimeMs, me.id);
      // Seat them straight after the last player on this device.
      let at = lobby.players.length;
      for (let i = 0; i < lobby.players.length; i++) if (mine(lobby.players[i])) at = i + 1;
      lobby.players.splice(at, 0, p);
      return;
    }
    case 'endTurn': {
      if (!lobby.started) return;
      const current = lobby.players[lobby.currentIndex];
      if (current && (mine(current) || isHost)) endTurn(lobby);
      return;
    }
    case 'pause':
      pauseGame(lobby, me.id);
      return;
    case 'resume':
      if (lobby.resumeLocked && !isHost) return;
      resumeGame(lobby);
      return;

    // ---- host only ----
    case 'start':
      if (isHost) startGame(lobby);
      return;
    case 'reset':
      if (isHost) resetGame(lobby);
      return;
    case 'setDefaultTime': {
      if (!isHost || lobby.started) return;
      const ms = clampTimeMs(msg.minutes);
      if (ms == null) return;
      lobby.defaultTimeMs = ms;
      for (const p of lobby.players) {
        if (!p.customTime) {
          p.baseTimeMs = ms;
          p.timeLeftMs = ms;
        }
      }
      return;
    }
    case 'adjustTime': {
      // Paused only; applied immediately so every screen sees it live.
      if (!isHost || !lobby.started || !lobby.paused) return;
      const p = lobby.players.find((x) => x.id === msg.playerId);
      const delta = Math.round(Number(msg.seconds) * 1000);
      if (!p || !Number.isFinite(delta)) return;
      const next = Math.min(MAX_TIME_MS, Math.max(0, p.timeLeftMs + delta));
      p.adjustMs = (p.adjustMs || 0) + (next - p.timeLeftMs);
      p.timeLeftMs = next;
      lobby.resumeLocked = true;
      return;
    }
    case 'setPlayerTime': {
      if (!isHost || lobby.started) return;
      const p = lobby.players.find((x) => x.id === msg.playerId);
      const ms = clampTimeMs(msg.minutes);
      if (!p || ms == null) return;
      p.baseTimeMs = ms;
      p.timeLeftMs = ms;
      p.customTime = true;
      return;
    }
    case 'setMaxPlayers': {
      if (!isHost) return;
      lobby.maxPlayers = clampInt(msg.value, lobby.players.length, MAX_PLAYERS_CAP, lobby.maxPlayers);
      return;
    }
    case 'setIncrement': {
      if (!isHost || lobby.started) return;
      lobby.incrementMs = clampInt(msg.seconds, 0, 600, 0) * 1000;
      return;
    }
    case 'move': {
      // Moves the player's whole device group past its neighbour.
      if (!isHost || lobby.started) return;
      const p = lobby.players.find((x) => x.id === msg.playerId);
      if (!p) return;
      const groups = deviceGroups(lobby.players);
      const i = groups.findIndex((g) => deviceOf(g[0]) === deviceOf(p));
      const j = i + (Number(msg.dir) < 0 ? -1 : 1);
      if (j < 0 || j >= groups.length) return;
      [groups[i], groups[j]] = [groups[j], groups[i]];
      lobby.players = groups.flat();
      return;
    }
    case 'kick': {
      // Host: anyone but their own device's primary. Owner: their extra players.
      // Removing a device's primary removes everyone on that device.
      if (lobby.started) return;
      const p = lobby.players.find((x) => x.id === msg.playerId);
      if (!p || p.id === me.id) return;
      if (!isHost && !mine(p)) return;
      if (p.id === lobby.hostPlayerId) return;
      if (deviceOf(p) !== p.id) {
        lobby.players = lobby.players.filter((x) => x.id !== p.id);
        return;
      }
      lobby.players = lobby.players.filter((x) => deviceOf(x) !== p.id);
      return p.id;
    }
    case 'makeHost': {
      if (!isHost) return;
      const p = lobby.players.find((x) => x.id === msg.playerId);
      if (p && deviceOf(p) === p.id) lobby.hostPlayerId = p.id;
      return;
    }
  }
}
