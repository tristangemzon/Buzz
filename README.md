# Buzz

A nostalgia-driven, AIM/AOL-flavoured **secure peer-to-peer chat client**, built with Electron + React + TypeScript and powered by [`js-libp2p`](https://github.com/libp2p/js-libp2p) (Noise XX + Yamux + KadDHT) and **SQLCipher** for encrypted local storage.

> **v0.5.1** — Everything in v0.3.9, plus: **Audio Settings** (per-device mic/speaker selection, gain sliders, noise suppression, echo cancellation, PTT key binding), **Desktop Notifications** (opt-in OS notifications for incoming IMs when Buzz is not focused), **Inline Image Previews** (received image files render inline in the chat log via the `buzz-file://` protocol), **Message Edit & Delete** (right-click any outbound message to edit or delete; deleted messages show a tombstone; edited messages are marked), **Message Reactions** (right-click any message → Add Reaction; a fixed emoji grid lets you react; reaction pills appear below messages), **Message Search** (Cmd/Ctrl+F opens a search bar that queries full-text history with live results), **Games in Rooms** (the 🎲 Games button in multi-party chat rooms lets you challenge any room member to a game), and **Server Mode Parity** (read receipts, typing indicators, and reactions are fully relayed through Hive).

## Features in this build

### Identity & storage

- **Self-generated Ed25519 identity**, sealed with your passphrase via Argon2id (libsodium).
- **Encrypted local SQLite** (SQLCipher via `better-sqlite3-multiple-ciphers`); DB key derived from your seed. Schema migrations run automatically on unlock.
- **Multiple profiles** on one machine — pick from the Sign-On screen, each with its own keystore + DB.
- **Factory reset** wipes the local profile cleanly.

### Networking — three modes

Switch modes in Settings → Network (or via the `NetworkConfig` IPC before signing on).

#### `p2p` — libp2p (default)

- **`js-libp2p` host** with Noise XX, Yamux, TCP + WebSockets, Kad DHT, and circuit-relay-v2 client.
- **Automatic LAN discovery** via mDNS; **DHT bootstrap** via public IPFS bootstrap nodes for internet reachability.
- **Presence login burst** re-announces at 2 s / 5 s / 12 s / 25 s after sign-in to catch peers who are already online.
- **Offline debounce** (6 s default, 18 s during active calls) prevents flicker when libp2p re-negotiates transports.

#### `server` — Hive server

- Connects to a Buzz **Hive server** over WSS; replaces the libp2p stack entirely.
- **Ed25519 challenge-response authentication** — the server never sees your private key.
- Full buddy list, presence, rooms, file transfer, and talk signalling all route through the server.
- Optional **local message cache** (enabled by default) so history survives server restarts.

#### `exp-p2p` — Buzz Mesh (Tailscale)

- Spawns a **Go sidecar** (`buzz-mesh`) that joins a shared Tailscale tailnet via [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet).
- The sidecar exposes a **local SOCKS5 proxy** so libp2p can reach other nodes' `100.x.x.x` Tailscale addresses through the userspace VPN without any OS-level Tailscale client.
- A Tailscale inbound forwarder on port 14001 bridges remote mesh peers back into the local libp2p host.
- The sidecar's `/peers` endpoint returns only **online** (Tailscale-reachable) peers, so libp2p never wastes dial attempts on offline tailnet members.
- A **mesh dial burst** fires at 2 s / 5 s / 10 s / 20 s / 40 s after login, then polls every 60 s; after a successful libp2p connect, any pending outgoing buddy requests are retried automatically.
- The 📡 **Mesh Debug** button appears in the buddy list action bar when in `exp-p2p` mode, opening a live diagnostic window (auto-refreshes every 5 s) showing mesh state, Tailscale IP, SOCKS5 port, online tailnet peers, libp2p connections, and recent dial errors.

### Custom IM protocol

- `/buzz/im/1.0.0` — length-prefixed CBOR frames, 256 KiB cap.
- Carries: IMs, typing/read receipts, profile cards, buddy requests, room control, talk/video signalling, voice-channel audio, game moves.

### Buddy management

- **Buddy request approval flow**: outgoing requests can be approved, denied, or cancelled; only mutual buddies see each other's presence.
- **Buddy groups**: organise contacts into named groups.
- **Block** a buddy to suppress all incoming messages and presence.
- **Warn level** (0–100 %, AIM-era): increase a buddy's warn level; buddies with high warn levels are visible to others.
- **Rename** any buddy with a local alias.

### 1:1 messaging

- **Rich-text IM** (bold/italic/underline/strike, links, line-breaks) with format toolbar and keyboard shortcuts.
- **Typing indicators** and **read receipts** in-window.
- **Presence & away messages**: online / away / invisible, custom away text shown in the buddy list and on hover.
- **Profile cards**: edit your own info pane (display name, location, blurb, avatar, background image) and view buddies' cards.
- **File transfer** with offer/accept/reject + per-chunk progress (`/buzz/xfer/1.0.0`).

### Voice & video calls

- **1:1 Talk (voice)** and **video calls** in a dedicated 4:3 Video Call window — Opus audio over libp2p, end-to-end encrypted on the existing Noise XX stream; H.264/VP8 video via `MediaRecorder` chunks.
- Live waveform visualisation, push-to-mute, hang-up-on-window-close.
- Calls are launched from the IM toolbar or the buddy list and can be voice-only or upgraded to video.

### Multi-party chat rooms

- **Per-room 32-byte symmetric key**, sealed inside the already Noise-XX-encrypted IM channel. Messages are XSalsa20-Poly1305 secretbox'd and fanned out full-mesh to room members.
- **Text channels** within a room (Discord-style), with a default `#general`.
- **Voice channels** (🔊): join/leave/mute, live participant list, per-peer playback sinks. Audio is captured at 80 ms timeslices via `MediaRecorder` (Opus/WebM), encrypted with the room key, and played back through per-peer `MediaSource` sinks.
- Per-room invite flow, leave, member roster, and unread counters.

### In-client games

Challenge any buddy to a 1:1 game directly from the IM window. Each game opens in a dedicated **Game** window; moves are sent peer-to-peer over the existing IM connection (no separate protocol).

| Game | Notes |
|------|-------|
| **Checkers** | Standard 8×8 draughts with multi-jump support |
| **Chess** | Full rules including castling and en passant |
| **Reversi** | Classic Othello-style board |
| **Gomoku** | Five-in-a-row on a 15×15 grid |
| **Poker** | Texas Hold 'em (heads-up) |
| **Spades** | Classic trick-taking card game |

### Offline delivery

- **Offline mailbox relay** (`/buzz/mailbox/1.0.0`): when a buddy is offline, the sender pushes an anonymous **libsodium sealed-box** envelope (X25519 derived from the recipient's Ed25519 PeerId) to one of the recipient's configured relays. Inside the sealed plaintext is a CBOR `InnerEnvelope` with a domain-separated Ed25519 signature so the recipient verifies authenticity end-to-end. Relays cannot read or forge envelopes; any client can act as a relay (200-envelope-per-recipient cap, 30-day TTL). Recipients periodically poll their relays and ack delivered envelopes so storage is freed.

### UI / skinning

- **AIM 5.x-style UI** with platform-aware fonts:
  - **macOS**: `Lucida Grande` UI / chat font.
  - **Windows / Linux**: `Tahoma` UI, `Times New Roman` chat font.
  - Override via the `skin` pref (`auto` | `mac` | `windows`).
- **iChat-style chat themes**: classic / balloons / compact, with customisable my/their bubble colours, optional timestamps and avatars.
- **Per-event sounds** (door open/close, IM send/receive, buddy on/off) with mute toggle and multiple sound schemes.
- **Custom window chrome** that adapts to platform skin.
- **Settings window** (⚙️ in the buddy list action bar): four-tab panel covering Themes, Sounds, Audio, and Auto-updates.

### Auto-updates

- Built on [`electron-updater`](https://www.electron.build/auto-update) + **GitHub Releases**.
- Running `npm run pack:mac` / `pack:win` / `pack:linux` builds the installer, generates a `latest-*.yml` manifest (version + SHA-512 hash), and uploads both to the matching GitHub Release.
- At runtime the app fetches the manifest from the public GitHub API — no token required.
- Updates are **opt-in**: the download doesn't start until the user clicks **Download Update** in Settings; **Install & Restart** applies it.
- Silent no-op in `npm run dev` (no packaged `app-update.yml` present).

### Security

- Sandboxed renderers (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`), strict CSP, all IPC payloads validated with `zod`.

### Message interactions (v0.5.0)

- **Inline image previews**: completed image-file transfers render inline in the chat log via the `buzz-file://` privileged protocol.
- **Edit & delete**: right-click any outbound message to edit it inline or delete it (shows a tombstone). Edits and deletes sync to peers in server mode.
- **Reactions**: right-click any message → *Add Reaction* → pick from a 20-emoji grid. Reaction pills appear below the message; click a pill to toggle. Synced via Hive in server mode.
- **Message search**: Cmd/Ctrl+F opens a sticky search bar. Results are filtered in real time against the full local message history.

### Audio settings (v0.5.0)

- **Device selection**: choose mic and speaker independently from all OS-enumerated devices.
- **Gain control**: separate input (mic) and output gain sliders (0–200 %).
- **Noise suppression** and **echo cancellation** toggles.
- **Push-to-talk key**: configurable from the Audio tab (default `b`).
- **Desktop notifications**: opt-in OS-level notification for incoming IMs when Buzz is not the focused window.

### Games in rooms (v0.5.0)

- The 🎲 **Games** button in multi-party chat rooms lets you challenge any room member to a 1:1 game directly from the room window — no need to open a separate IM window.

## Run it

```bash
npm install
npm run dev
```

To test peer-to-peer locally, launch a second instance pointing at a different `userData` dir:

```bash
# macOS / Linux example
USER_DATA_DIR=$(mktemp -d) npm run dev
```

(or run the built app from two machines on the same LAN, or on the same Tailscale tailnet in `exp-p2p` mode)

### First-time flow

1. **Sign On** window asks you to create a screen name and passphrase.
2. The Buddy List opens. Click **My Info** to copy your **buddy code** (a base58 PeerId).
3. On the second instance, click **Add Buddy**, paste the code, and give it a display name. The other side receives an approval prompt.
4. Once approved, double-click the buddy in the list to open an IM window — from there you can send files, start voice/video calls, create a chat room, or challenge them to a game.
5. In a chat room, click **+** in the channel sidebar to add a Text or **Voice** channel; voice channels show a 🔊 icon and have Join / Mute / Leave buttons.

## Project layout

```
src/
  main/                Electron main process
    crypto/            Keystore (Argon2id + libsodium), sealed-box helpers
    db/                SQLCipher schema + repository layer + migrations
    p2p/               libp2p node, IM protocol, rooms, mailbox, presence,
                       file transfer, talk (audio/video) signalling,
                       Buzz Mesh sidecar manager + custom SOCKS5 transport,
                       Hive server client
    ipc/               Typed IPC handlers (zod-validated)
    session.ts         Locked/unlocked app state + event fan-out
    index.ts           Entry: lifecycle + windows
  preload/             contextBridge → typed window.buzz API
  renderer/            React UIs (Vite multi-entry)
    theme/             AIM 5.x stylesheet + platform/skin switcher
    components/        Window chrome, profile pane, theme settings,
                       rich-text editor, useRoomVoice hook, ...
    sounds/            Synthesised AIM-era sound effects
    windows/
      SignOn/          Create / unlock identity, pick profile
      BuddyList/       Buddy list, Add Buddy, My Info, prefs
      IM/              1:1 IM window (rich text, file xfer, call/game buttons)
      Chat/            Multi-party chat room (text + voice channels)
      VideoCall/       Dedicated 4:3 video call window
      Game/            In-client game window (Checkers, Chess, Reversi,
                       Gomoku, Poker, Spades)
      Settings/        Settings window (Themes / Sounds / Updates)
      MeshDebug/       Buzz Mesh live diagnostic window (exp-p2p only)
  shared/              Cross-process types, IPC channels, zod schemas
buzz-mesh/             Go sidecar (tsnet Tailscale bridge + SOCKS5 proxy)
```

## Security notes

- All persistent state (buddies, history, prefs, profiles, room keys) is stored in **SQLCipher** with a key derived from your seed; the DB file is unreadable without your passphrase.
- The libp2p transport authenticates peers cryptographically via **Noise XX**; your **PeerId is your identity** — screen names are local cosmetic aliases.
- Room messages and voice-channel audio are additionally **secret-boxed with the per-room key** before going on the wire, so even a compromised libp2p stream wouldn't reveal room contents.
- In Buzz Mesh mode, `@libp2p/tcp` is patched to reject all `100.x.x.x` addresses, ensuring Tailscale peers are only ever dialled through the SOCKS5 proxy (never directly via the OS network stack, which can't reach tsnet addresses).
- Renderers cannot touch Node APIs; everything goes through the typed, schema-validated IPC bridge.

## What's not built yet (planned)

- Code signing / notarisation (macOS Gatekeeper).
