# ⏱️ TurnTimer

A multiplayer chess clock for board games. Any phone at the table can control the
shared clock: players end their turn from their own device, or several players share
one. The server keeps every screen in sync.

- **Dashboard** creates a lobby and gives you a share link.
- Players open the link, pick a name, and land in the lobby.
- The **host** sets time per player, per-turn increment, max players, turn order,
  can override an individual player's time, rename/kick players, and starts the game.
- Each player can rename themselves. Players without a phone can be added under
  someone else's device; they sit next to each other and share that phone.
- While paused, the host can add or subtract time from any clock; everyone sees
  it live, and only the host can resume once they've changed something.
- In game: your clock fills the screen with a big **END TURN** button. Ending your
  turn banks your time, adds the Fischer increment, and starts the next player's
  clock (around the table). A smaller **PAUSE** button freezes every clock for
  everyone; **RESUME** continues from exactly where it stopped.
- Clocks **count down and stop at 0:00**. A player at zero is shown flagged; the
  host decides what that means for your game. No increment is credited once flagged.

## Design

- **Cloudflare Worker + one Durable Object per lobby.** The Worker (`src/index.js`)
  serves the static frontend from `public/` and routes `/ws?lobby=<id>` to that
  lobby's Durable Object (`src/lobby.js`), which holds one WebSocket per client.
  Game logic is pure and lives in `src/game.js`.
- **Server is the only clock.** It stores each player's banked milliseconds plus
  the timestamp the running segment began. Clients receive snapshots and
  interpolate the one running clock locally for a smooth display — they never
  decide how much time is left. A resync broadcast every 30 s while a game runs
  keeps everyone corrected; nothing runs between events otherwise.
- **Durable storage, no database.** Each lobby is a JSON blob in its Durable
  Object's storage, so it survives restarts and evictions. Sockets use the
  Hibernation API, so idle lobbies cost nothing. A lobby is deleted 6 h after the
  last player disconnects.
- **Reconnects** are automatic: the client stores a per-lobby token in
  `localStorage` and re-attaches to the same player on reconnect.

## Run locally

```bash
npm install
npm run dev               # http://localhost:8787
```

Open the dashboard, create a lobby, and open the share link on other devices on
the same network (`npx wrangler dev --ip 0.0.0.0` and use your machine's LAN IP
instead of `localhost`). Local state persists in `.wrangler/`.

## Deploy

```bash
npx wrangler login        # once
npm run deploy            # https://turntimer.<subdomain>.workers.dev
npx wrangler tail         # live logs
```

The first deploy of a new Worker can fail HTTPS with a TLS handshake error for a
few minutes while the certificate is issued; wait it out.

## Message protocol (client ↔ server, JSON over `/ws`)

| Client → server | Purpose |
| --- | --- |
| `create` `{name, minutes, incrementSeconds, maxPlayers}` | make a lobby, become host |
| `hello` `{lobbyId, token?, name?}` | join / reconnect |
| `setName` `{playerId?, name}` | rename yourself or a player on your device |
| `addLocalPlayer` `{name}` | add a player who shares your device, pre-start |
| `start` / `reset` | host: begin / return to lobby |
| `endTurn` | a player on the current player's device (or host) ends the turn |
| `pause` / `resume` | anyone: freeze / continue all clocks (resume is host-only once times were adjusted) |
| `adjustTime` `{playerId, seconds}` | host, while paused: add/subtract time, shown live |
| `setDefaultTime` `{minutes}`, `setPlayerTime` `{playerId, minutes}` | host, pre-start |
| `setIncrement` `{seconds}`, `setMaxPlayers` `{value}` | host |
| `move` `{playerId, dir}`, `makeHost` `{playerId}` | host, pre-start; `move` shifts the whole device |
| `kick` `{playerId}` | host (anyone; a device's main player takes its extras too), or owner of an extra player, pre-start |

Server → client is a single `state` snapshot (`{serverNow, you, lobby}`) after
every change and every 30 s while running, or `error` `{error}` for fatal
conditions (lobby gone, full, already started, kicked).
