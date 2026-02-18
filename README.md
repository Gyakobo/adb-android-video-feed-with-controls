# scrcpy-server

A minimal Node.js + TypeScript server that mirrors one or multiple Android devices in the browser using the scrcpy protocol.

## How it works

1. Pushes `scrcpy-server.jar` to connected Android devices via ADB
2. Launches the JAR with `adb shell app_process` — no app install required
3. Opens an ADB-forwarded TCP socket for the raw H.264 video stream
4. Opens a second socket for control messages (touch, keys)
5. A WebSocket bridge relays frames to the browser as base64
6. The browser decodes H.264 using the **WebCodecs API** and renders to `<canvas>`
7. Mouse/touch events on the canvas are encoded into scrcpy control messages and sent back

## Prerequisites

- Node.js 18+
- ADB installed and in `$PATH`
- Android device with **USB debugging enabled**
- Browser with WebCodecs API support (Chrome 94+, Edge 94+)
- `scrcpy-server.jar` from a scrcpy release — place it at `public/server/scrcpy-server.jar`

## Setup

```bash
# 1. Download the scrcpy server jar (match version in src/adb.ts → SCRCPY_SERVER_VERSION)
#    From: https://github.com/Genymobile/scrcpy/releases — grab scrcpy-server-vX.X
cp ~/Downloads/scrcpy-server-v3.1 public/server/scrcpy-server.jar

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Run
npm start
```

Or for dev (no build step):
```bash
npm run dev
```

Open http://localhost:3000 in Chrome/Edge.

## Architecture

```
Browser (canvas + WebCodecs)
    ↕ WebSocket /ws
Node.js Express Server
    ↕ ADB forward tcp:2720x
Android Device (scrcpy-server.jar via app_process)
```

### File overview

| File | Role |
|------|------|
| `src/index.ts` | Express server + startup |
| `src/adb.ts` | ADB commands (push, forward, spawn) |
| `src/protocol.ts` | scrcpy binary protocol (frame parsing, control msg builders) |
| `src/session.ts` | Per-device session (video socket, control socket, lifecycle) |
| `src/ws-bridge.ts` | WebSocket ↔ session bridge |
| `public/index.html` | Browser UI (WebCodecs decoder, canvas, touch forwarding) |

## Limitations

- Audio is disabled (add `audio=true` and a second socket + AudioDecoder for audio support)
- Uses JSON+base64 over WebSocket — for production use binary WebSocket frames
- WebCodecs requires HTTPS or localhost
- The server JAR must be downloaded separately from scrcpy releases
