# Buzz

A nostalgia-driven, AIM/AOL-flavoured **secure peer-to-peer chat client**, built with Electron + React + TypeScript and powered by [`js-libp2p`](https://github.com/libp2p/js-libp2p) (Noise XX + Yamux + KadDHT) and **SQLCipher** for encrypted local storage.

> Status: **early scaffold, but feature-rich.** Sign-on, buddy list, 1:1 IM, encrypted local DB, P2P transport, platform-aware Mac/Windows skinning, profile customization, file transfer, iChat-style theming, presence/away messages, sounds, **multi-party chat rooms (with text *and* voice channels)**, **1:1 voice + video calls**, **offline mailbox relay**, and **auto-updates via GitHub Releases** are all wired up.

## Features in this build

### Identity & storage

- **Self-generated Ed25519 identity**, sealed with your passphrase via Argon2id (libsodium).
- **Encrypted local SQLite** (SQLCipher via `better-sqlite3-multiple-ciphers`); DB key derived from your seed. Schema migrations run automatically on unlock.
- **Multiple profiles** on one machine — pick from the Sign-On screen, each with its own keystore + DB.
- **Factory reset** wipes the local profile cleanly.

### Networking

- **`js-libp2p` host** with Noise XX, Yamux, TCP + WebSockets, Kad DHT, and circuit-relay-v2 client.
- **Custom IM protocol** `/buzz/im/1.0.0` (length-prefixed CBOR frames, 256 KiB cap) — carries IMs, typing/read receipts, profile cards, room control, talk/video signalling, and voice-channel audio.
- **Automatic peer discovery** on the local network via mDNS (in P2P mode).
- **Buddy request approval flow**: outgoing requests can be approved, denied, or cancelled; only mutual buddies see your presence.
- **Presence heartbeat** every 10 s keeps buddy statuses fresh; a **login burst** re-announces at 2 s / 5 s / 12 s / 25 s after sign-in to catch peers who are already online.
- **Offline debounce** (6 s default, 18 s during active calls) prevents flicker when libp2p re-negotiates transports.

### 1:1 messaging

- **Rich-text IM** (bold/italic/underline/strike, links, line-breaks) with format toolbar and keyboard shortcuts.
- **Typing indicators** and **read receipts** in-window.
- **Presence & away messages**: online / away / invisible, custom away text shown in the buddy list and on hover.
- **Profile cards**: edit your own info pane (display name, location, blurb, avatar) and view buddies' cards.
- **File transfer** with offer/accept/reject + per-chunk progress (`/buzz/xfer/1.0.0`).

### Voice & video calls

- **1:1 Talk (voice)** and **video calls** in a dedicated 4:3 Video Call window — Opus audio over libp2p, end-to-end encrypted on the existing Noise XX stream; H.264/VP8 video via `MediaRecorder` chunks.
- Live waveform visualisation, push-to-mute, hang-up-on-window-close.
- Calls are launched from the IM toolbar or the buddy list and can be voice-only or upgraded to video.

### Multi-party chat rooms

- **Per-room 32-byte symmetric key**, sealed inside the already Noise-XX-encrypted IM channel. Messages are XSalsa20-Poly1305 secretbox'd and fanned out full-mesh to room members. Conceptually equivalent to gossipsub + a sealed room key, without an extra protocol.
- **Text channels** within a room (Discord-style), with a default `#general`.
- **Voice channels** (🔊): join/leave/mute, live participant list, per-peer playback sinks. Audio is captured at 80 ms timeslices via `MediaRecorder` (Opus/WebM), encrypted with the room key, and played back through per-peer `MediaSource` sinks.
- Per-room invite flow, leave, member roster, and unread counters.

### Offline delivery

- **Offline mailbox relay** (`/buzz/mailbox/1.0.0`): when a buddy is offline, the sender pushes an anonymous **libsodium sealed-box** envelope (X25519 derived from the recipient's Ed25519 PeerId) to one of the recipient's configured relays. Inside the sealed plaintext is a CBOR `InnerEnvelope` with a domain-separated Ed25519 signature so the recipient verifies authenticity end-to-end. Relays cannot read or forge envelopes; any client can act as a relay (200-envelope-per-recipient cap, 30-day TTL). Recipients periodically poll their relays and ack delivered envelopes so storage is freed.

### UI / skinning

- **AIM 5.x-style UI** with platform-aware fonts:
  - **macOS**: `Lucida Grande` UI / chat font.
  - **Windows / Linux**: `Tahoma` UI, `Times New Roman` chat font.
  - Override via the `skin` pref (`auto` | `mac` | `windows`).
- **iChat-style chat themes**: classic / balloons / compact, with customisable my/their bubble colours, optional timestamps and avatars.
- **Per-event sounds** (door open/close, IM send/receive, buddy on/off) with mute toggle.
- **Custom window chrome** that adapts to platform skin.
- **Settings panel** (⚙️ in the buddy list action bar): auto-update status, Check Now / Download / Install & Restart buttons.

### Auto-updates

- Built on [`electron-updater`](https://www.electron.build/auto-update) + **GitHub Releases**.
- Running `npm run pack:mac` / `pack:win` / `pack:linux` builds the installer, generates a `latest-*.yml` manifest (version + SHA-512 hash), and uploads both to the matching GitHub Release.
- At runtime the app fetches the manifest from the public GitHub API — no token required.
- Updates are **opt-in**: the download doesn't start until the user clicks **Download Update** in Settings; **Install & Restart** applies it.
- Silent no-op in `npm run dev` (no packaged `app-update.yml` present).

### Security

- Sandboxed renderers (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`), strict CSP, all IPC payloads validated with `zod`.

## Run it

```bash
npm install
npm run dev
```

Then to test peer-to-peer locally, launch a second instance pointing at a different `userData` dir:

```bash
# macOS / Linux example
USER_DATA_DIR=$(mktemp -d) npm run dev
```

(or just run the built app from two machines on the same network)

### First-time flow

1. **Sign On** window asks you to create a screen name and passphrase.
2. The Buddy List opens. Click **My Info** to copy your **buddy code** (a base58 PeerId).
3. On the second instance, click **Add Buddy**, paste the code, and give it a display name. The other side receives an approval prompt.
4. Once approved, double-click the buddy in the list to open an IM window — from there you can send files, start voice/video calls, or create a chat room and invite them.
5. In a chat room, click **+** in the channel sidebar to add a Text or **Voice** channel; voice channels show a 🔊 icon and have Join / Mute / Leave buttons.

## Project layout

```
src/
  main/                Electron main process
    crypto/            Keystore (Argon2id + libsodium), sealed-box helpers
    db/                SQLCipher schema + repository layer + migrations
    p2p/               libp2p node, IM protocol, rooms, mailbox, presence,
                       file transfer, talk (audio/video) signalling
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
      IM/              1:1 IM window (rich text, file xfer, call buttons)
      Chat/            Multi-party chat room (text + voice channels)
      VideoCall/       Dedicated 4:3 video call window
  shared/              Cross-process types, IPC channels, zod schemas
```

## Security notes

- All persistent state (buddies, history, prefs, profiles, room keys) is stored in **SQLCipher** with a key derived from your seed; the DB file is unreadable without your passphrase.
- The libp2p transport authenticates peers cryptographically via **Noise XX**; your **PeerId is your identity** — screen names are local cosmetic aliases.
- Room messages and voice-channel audio are additionally **secret-boxed with the per-room key** before going on the wire, so even a compromised libp2p stream wouldn't reveal room contents.
- Renderers cannot touch Node APIs; everything goes through the typed, schema-validated IPC bridge.

## What's not built yet (planned)

- Code signing / notarisation (macOS Gatekeeper).
