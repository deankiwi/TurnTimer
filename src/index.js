/*
 * TurnTimer Worker: routing only.
 *
 *   /healthz          -> ok
 *   /ws?lobby=<id>    -> that lobby's Durable Object
 *   /ws?lobby=new     -> a fresh lobby id, forwarded with create=1
 *                        (/ws is limited to 100 connections per IP per minute)
 *   anything else     -> static assets from public/ (SPA fallback for /l/:id)
 */

import { rid } from './game.js';

export { Lobby } from './lobby.js';

const LOBBY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') return new Response('ok');

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.WS_LIMITER.limit({ key: ip });
      if (!success) return new Response('Too many connections, try again in a minute', { status: 429 });
      let id = url.searchParams.get('lobby') || '';
      if (id === 'new') {
        id = rid(6);
        url.searchParams.set('lobby', id);
        url.searchParams.set('create', '1');
      } else {
        url.searchParams.delete('create');
      }
      if (!LOBBY_ID_RE.test(id)) return new Response('Bad lobby id', { status: 400 });
      const stub = env.LOBBY.get(env.LOBBY.idFromName(id));
      return stub.fetch(new Request(url, req));
    }

    return env.ASSETS.fetch(req);
  },
};
