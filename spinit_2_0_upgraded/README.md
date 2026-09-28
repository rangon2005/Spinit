# Spinit — Vercel + External WebSocket Matchmaking

This build keeps the optimized frontend/P2P architecture:

- Incremental keyed chat DOM updates.
- Event delegation for chat interactions.
- Lightweight animations, reduced blur, mobile performance mode, and `prefers-reduced-motion`.
- WebSocket is used only for matchmaking/rendezvous.
- PeerJS/WebRTC is used for the actual user-to-user connection.
- TURN credentials are fetched server-side from `/api/turn-credentials`.
- Game snapshots are coalesced and interpolated to avoid stale packet buildup.

## The final architecture

```text
Vercel
  └── index.html + spinit-config.js
          │
          ├── WSS ───────────────► External Node.js server /ws/match
          │
          └── HTTPS ─────────────► External Node.js server /api/turn-credentials
                                           │
                                           └── TURN credentials

User A  ◄──────── PeerJS/WebRTC P2P ────────► User B
                  (TURN fallback)
```

## 1. Deploy the external WebSocket server

Create a GitHub repository and upload the contents of this project. The repository should contain:

```text
spinit_optimized/
  index.html
  spinit-config.js
  server/
    server.js
    package.json
    .env.example
```

On Render, create a **Web Service** from the GitHub repository.

Use:

- Root Directory: `server`
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: Node

The server already exposes:

- `GET /health`
- `GET /api/turn-credentials`
- `WS /ws/match`

After deployment, copy the HTTPS service URL, for example:

```text
https://spinit-matchmaking.onrender.com
```

Do not add `/ws/match` to the config URL; the frontend adds it automatically.

## 2. Configure production TURN

Create a production TURN service/account (for example Metered, Twilio Network Traversal, Cloudflare Calls, or your own coturn).

On the external Node server, add environment variables:

```text
TURN_URLS=turn:YOUR_TURN_HOST:3478,turns:YOUR_TURN_HOST:5349
TURN_USERNAME=YOUR_TURN_USERNAME
TURN_CREDENTIAL=YOUR_TURN_CREDENTIAL
FRONTEND_ORIGIN=https://YOUR-VERCEL-PROJECT.vercel.app
```

Never put the TURN username/credential into `index.html` or `spinit-config.js`.

Test the backend:

```text
https://YOUR-SERVER/health
```

It should return JSON with `ok: true`.

Then:

```text
https://YOUR-SERVER/api/turn-credentials
```

should return an `iceServers` JSON object. Do not publish the returned credentials publicly.

## 3. Point the Vercel frontend at the external server

Edit `spinit-config.js`:

```js
window.SPIN_MATCH_WS_URL = 'wss://YOUR-SERVER/ws/match';
window.SPIN_TURN_API_URL = 'https://YOUR-SERVER';
```

Example:

```js
window.SPIN_MATCH_WS_URL = 'wss://spinit-matchmaking.onrender.com/ws/match';
window.SPIN_TURN_API_URL = 'https://spinit-matchmaking.onrender.com';
```

## 4. Deploy the frontend to Vercel

Upload the project to GitHub, then import that repository into Vercel.

If the repository root contains `index.html` and `spinit-config.js`, use the project root as the Vercel root. No server folder should be deployed as the Vercel frontend.

After deployment, open the Vercel URL in two separate browser windows/devices and test Quick Match.

## Local test

External server:

```bash
cd server
npm install
npm start
```

Then set in `spinit-config.js` for local testing:

```js
window.SPIN_MATCH_WS_URL = 'ws://wss://spinit-b4sk.onrender.com/ws/match';
window.SPIN_TURN_API_URL = 'http://https://spinit-b4sk.onrender.com';
```

For production, always use HTTPS/WSS.
