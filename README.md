# Buzz

A nostalgia-driven, AIM/AOL-flavoured **secure peer-to-peer chat client**, built with Electron + React + TypeScript and powered by [`js-libp2p`](https://github.com/libp2p/js-libp2p) (Noise XX + Yamux + Bootstrap + mDNS) and **SQLCipher** for encrypted local storage.

> **v0.9.6** — final 0.9.x ahead of 1.0. Voice channels with multi-peer screen share, rich mailbox (offline IMs + voice memos), in-IM voice memos, file-transfer hardening with drag-and-drop + history, encrypted backups + identity import, onboarding polish (strength meter + buddy-code QR), per-buddy / per-room mute, Do Not Disturb, crash reporter (local-only), opt-in local usage stats, and a redacted main-process log in production builds.

## Features

### Identity & storage

- **Self-generated Ed25519 identity**, sealed with your passphrase via Argon2id (libsodium).
- **Encrypted local SQLite** (SQLCipher via `better-sqlite3-multiple-ciphers`); DB key derived from your seed. Schema migrations run automatically on unlock.
- **Multiple profiles** on one machine — pick from the Sign-On screen, each with its own keystore + DB.
- **Onboarding polish**: live zxcvbn passphrase strength meter on identity creation; the buddy-code is a scannable QR (and you can scan a friend's QR straight from the **Add Buddy** dialog with your webcam).
- **Encrypted backup + restore**: export your full profile + history as a passphrase-sealed archive; import an identity onto a new machine in one click.
- **Plain history export** to Markdown / HTML for any conversation or room.
- **Factory reset** wipes the local profile cleanly.

### Networking — three modes

Switch modes in **Settings → Network** (or via the `NetworkConfig` IPC before signing on).

#### `p2p` — libp2p (default)

- **`js-libp2p` host** with Noise XX, Yamux, TCP + WebSockets, and circuit-relay-v2 client.
- **Automatic LAN discovery** via mDNS; **Bootstrap** via public IPFS bootstrap nodes for internet reachability.
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
- Carries: IMs, typing/read receipts, profile cards, buddy requests, room control + messages, talk/video signalling, voice-channel audio, **room screen-share video**, game moves.

### Buddy management

- **Buddy request approval flow**: outgoing requests can be approved, denied, or cancelled; only mutual buddies see each other's presence.
- **Buddy groups**: organise contacts into named groups.
- **Block** a buddy to suppress all incoming messages and presence.
- **Warn level** (0–100 %, AIM-era).
- **Rename** any buddy with a local alias.
- **Per-buddy mute**: silence one conversation without disabling global sounds.

### 1:1 messaging

- **Rich-text IM** (bold/italic/underline/strike, links, line-breaks) with format toolbar and keyboard shortcuts.
- **Typing indicators** and **read receipts** in-window.
- **Presence & away messages**: online / away / invisible / **Do Not Disturb**, custom away text shown in the buddy list and on hover. DND silences sounds and gates desktop notifications.
- **Profile cards**: edit your own info pane (display name, location, blurb, avatar, background image) and view buddies' cards.
- **Edit & delete** any outbound message (right-click); edits and deletes sync to peers in server mode.
- **Reactions**: right-click any message → *Add Reaction* → pick from a 20-emoji grid. Reaction pills appear below messages.
- **Message search**: Cmd/Ctrl+F opens a sticky search bar with live results.
- **Voice memos**: push-to-record a clip from the IM toolbar; sends inline with a waveform preview. Memos ride the same offline mailbox path as text (see *Offline delivery*).
- **File transfer** with offer/accept/reject + per-chunk progress (`/buzz/xfer/1.0.0`), **drag-and-drop into any IM**, transfer history, resume + retry, and inline image / audio thumbnails.
- **Inline previews** for completed image transfers via the privileged `buzz-file://` protocol.

### Voice & video calls

- **1:1 Talk (voice)** and **video calls** in a dedicated 4:3 Video Call window — Opus audio over libp2p, end-to-end encrypted on the existing Noise XX stream; VP8 video via `MediaRecorder` chunks.
- Live waveform visualisation, push-to-mute, hang-up-on-window-close.
- Launched from the IM toolbar or buddy list; voice-only or upgradable to video.

### Multi-party chat rooms

- **Per-room 32-byte symmetric key**, sealed inside the already Noise-XX-encrypted IM channel. Messages, voice audio, and screen video are XSalsa20-Poly1305 secretbox'd with the room key and fanned out full-mesh to room members.
- **Text channels** within a room (Discord-style), with a default `#general`.
- **Voice channels** (🔊): join/leave/mute, live participant list, per-peer playback sinks. Audio is captured at 80 ms timeslices via `MediaRecorder` (Opus/WebM), encrypted with the room key, and played back through per-peer `MediaSource` sinks.
- **Screen share in voice channels** (🖥): one presenter at a time, enforced server-side; late joiners reattach mid-stream; share auto-stops if you leave voice. VP8/WebM, choose between 480p / 720p / 1080p when picking a source.
- **Pin, edit, delete** for room messages; per-room invite flow, leave, member roster, unread counters; per-room mute.
- **Room-visible game challenges**: the 🎲 picker posts a synthetic room message announcing who challenged whom so everyone in the room sees it.

### In-client games

Challenge any buddy (or room member) to a 1:1 game directly from the IM or chat window. Each game opens in a dedicated **Game** window; moves are sent peer-to-peer over the existing IM connection (no separate protocol).

| Game | Notes |
|------|-------|
| **Checkers** | Standard 8×8 draughts with multi-jump support |
| **Chess** | Full rules including castling and en passant |
| **Reversi** | Classic Othello-style board |
| **Gomoku** | Five-in-a-row on a 15×15 grid |
| **Poker** | Texas Hold 'em (heads-up) |
| **Spades** | Classic trick-taking card game |

### Offline delivery — rich mailbox

- `/buzz/mailbox/1.0.0` — when a buddy is offline, the sender pushes an anonymous **libsodium sealed-box** envelope (X25519 derived from the recipient's Ed25519 PeerId) to one of the recipient's configured relays.
- Envelopes wrap a CBOR `InnerEnvelope` carrying **text IMs *and* voice memos**, with a domain-separated Ed25519 signature so the recipient verifies authenticity end-to-end.
- Relays cannot read or forge envelopes; any client can act as a relay (200-envelope-per-recipient cap, 30-day TTL).
- Recipients periodically poll their relays and ack delivered envelopes so storage is freed.

### Audio settings

- **Device selection**: choose mic and speaker independently from all OS-enumerated devices.
- **Gain control**: separate input (mic) and output gain sliders (0–200 %).
- **Noise suppression** and **echo cancellation** toggles.
- **Push-to-talk key**: configurable from the Audio tab (default `b`).

### Notifications

- Opt-in **OS desktop notifications** for incoming IMs when Buzz is not the focused window; auto-suppressed in DND.

### UI / skinning

- **AIM 5.x-style UI** with platform-aware fonts:
  - **macOS**: `Lucida Grande` UI / chat font.
  - **Windows / Linux**: `Tahoma` UI, `Times New Roman` chat font.
  - Override via the `skin` pref (`auto` | `mac` | `windows`).
- **iChat-style chat themes**: classic / balloons / compact, with customisable my/their bubble colours, optional timestamps and avatars.
- **Window themes**: classic, aqua, graphite, aero, metal, aluminum.
- **Color mode**: light / dark.
- **Per-event sounds** (door open/close, IM send/receive, buddy on/off) with mute toggle and multiple sound schemes.
- **Custom window chrome** that adapts to platform skin.
- **Settings window** (⚙️ in the buddy list action bar): Themes, Sounds, Audio, Updates, Backup, Transfers, About.

### Auto-updates

- Built on [`electron-updater`](https://www.electron.build/auto-update) + **GitHub Releases**.
- Running `npm run pack:mac` / `pack:win` / `pack:linux` builds the installer, generates a `latest-*.yml` manifest (version + SHA-512 hash), and uploads both to the matching GitHub Release.
- At runtime the app fetches the manifest from the public GitHub API — no token required.
- Updates are **opt-in**: the download doesn't start until you click **Download Update** in Settings; **Install & Restart** applies it.
- Silent no-op in `npm run dev` (no packaged `app-update.yml` present).

### Hardening (v0.9.5+)

- **Crash reporter**: Electron's `crashReporter` runs with `uploadToServer: false`. Dumps land in `<userData>/crashes/` and are **never uploaded anywhere** — they exist purely for you (or someone you forward one to) to debug a hard crash.
- **Production log redaction**: in packaged builds, the main process patches `console.{log,info,warn,error}` to scrub libp2p PeerIds (keeping the last 6 chars for triage) plus IPv4 / IPv6 addresses.
- **Opt-in local usage stats**: a Settings → **About** pane shows your Buzz version, the crash-dump path, and (when you toggle it on) local counters for IMs sent, 1:1 call count + duration, voice-channel joins, and screen shares. Nothing is uploaded; the counters live in your encrypted prefs row and have a Reset button.
- **Code signing**: macOS hardened-runtime + entitlements are wired by default; Windows signing kicks in automatically when `CSC_LINK` + `CSC_KEY_PASSWORD` env vars are set on the release pipeline (see [`docs/SIGNING.md`](docs/SIGNING.md)).
- **No DHT exposure**: `@libp2p/kad-dht` was dropped in v0.9.6 (we never queried it, peer discovery already runs through Bootstrap + mDNS + Tailscale) — closes [GHSA-32mq-hpph-xfvr](https://github.com/advisories/GHSA-32mq-hpph-xfvr); `npm audit` is clean.

### Security

- Sandboxed renderers (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`), strict CSP, all IPC payloads validated with `zod`.

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

1. **Sign On** window asks you to create a screen name and passphrase (live strength meter included).
2. The Buddy List opens. Click **My Info** to copy your **buddy code** (a base58 PeerId) or show its **QR**.
3. On the second instance, click **Add Buddy** and either paste the code or scan the QR with your webcam. The other side receives an approval prompt.
4. Once approved, double-click the buddy in the list to open an IM window — from there you can drag-and-drop a file, record a voice memo, start a voice/video call, create a chat room, or challenge them to a game.
5. In a chat room, click **+** in the channel sidebar to add a Text or **Voice** channel; voice channels show a 🔊 icon, have Join / Mute / Leave buttons, and a **Share Screen** button that fans VP8 video to everyone in the channel.

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
    backup.ts          Encrypted backup / restore + identity import
    log.ts             Production console redaction (PeerIds / IPs)
    telemetry.ts       Opt-in local usage counters
    session.ts         Locked/unlocked app state + event fan-out
    index.ts           Entry: lifecycle + windows + crashReporter
  preload/             contextBridge → typed window.buzz API
  renderer/            React UIs (Vite multi-entry)
    theme/             AIM 5.x stylesheet + platform/skin switcher
    components/        Window chrome, profile pane, theme settings,
                       rich-text editor, useRoomVoice, useRoomScreen,
                       useScreenCapture, ScreenSourcePicker, ...
    sounds/            Synthesised AIM-era sound effects
    windows/
      SignOn/          Create / unlock identity, pick profile
      BuddyList/       Buddy list, Add Buddy (paste or QR), My Info, prefs
      IM/              1:1 IM window (rich text, voice memos, file xfer,
                       call/game buttons, search, edit/delete, reactions)
      Chat/            Multi-party chat room (text + voice + screen-share)
      VideoCall/       Dedicated 4:3 video call window
      Game/            In-client game window (Checkers, Chess, Reversi,
                       Gomoku, Poker, Spades)
      Settings/        Themes / Sounds / Audio / Updates / Backup /
                       Transfers / About
      MeshDebug/       Buzz Mesh live diagnostic window (exp-p2p only)
  shared/              Cross-process types, IPC channels, zod schemas
buzz-mesh/             Go sidecar (tsnet Tailscale bridge + SOCKS5 proxy)
docs/
  SIGNING.md           Windows + macOS signing env vars
```

## Security notes

- All persistent state (buddies, history, prefs, profiles, room keys, telemetry counters) is stored in **SQLCipher** with a key derived from your seed; the DB file is unreadable without your passphrase.
- The libp2p transport authenticates peers cryptographically via **Noise XX**; your **PeerId is your identity** — screen names are local cosmetic aliases.
- Room messages, voice-channel audio, and screen-share video are additionally **secret-boxed with the per-room key** before going on the wire, so even a compromised libp2p stream wouldn't reveal room contents.
- Offline mailbox envelopes are **sealed-boxed to the recipient's X25519 key** (derived from their PeerId) and signed end-to-end inside the seal; relays cannot read or forge them.
- In Buzz Mesh mode, `@libp2p/tcp` is patched to reject all `100.x.x.x` addresses, ensuring Tailscale peers are only ever dialled through the SOCKS5 proxy.
- Crash dumps and telemetry counters are **local-only** — no network upload, ever.
- Renderers cannot touch Node APIs; everything goes through the typed, schema-validated IPC bridge.

## What's not built yet (planned)

- **Hive parity for room voice + screen share** — Hive currently relays IMs, presence, and 1:1 calls, but room-channel audio/video is still p2p-only.
- **Full Spectron / Playwright first-run E2E smoke** — the typecheck + lint + vitest suite + production build run on every release tag and cover the boot path, but a full Electron-launching rig is parked for a later infrastructure pass.
- **1.0** — once Hive parity for rooms lands, we cut 1.0.
