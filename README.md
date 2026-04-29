# Buzz

A nostalgia-driven, AIM/AOL-flavoured **secure peer-to-peer chat client**, built with Electron + React + TypeScript and powered by [`js-libp2p`](https://github.com/libp2p/js-libp2p) (Noise XX + Yamux + KadDHT) and **SQLCipher** for encrypted local storage.

> Status: **early scaffold**. Sign-on, buddy list, 1:1 IM, encrypted local DB, P2P transport, platform-aware Mac/Windows skinning, profile customization, file transfer, iChat-style theming, presence/away messages, sounds, **multi-party chat rooms**, and **offline mailbox relay** are wired.

## Features in this build

- **Self-generated Ed25519 identity**, sealed with your passphrase via Argon2id (libsodium).
- **Encrypted local SQLite** (SQLCipher via `better-sqlite3-multiple-ciphers`); DB key derived from your seed.
- **`js-libp2p` host** with Noise XX, Yamux, TCP + WebSockets, Kad DHT, and circuit-relay-v2 client.
- **Custom IM protocol** `/buzz/im/1.0.0` (length-prefixed CBOR frames, 256 KiB cap).
- **Multi-party chat rooms**: per-room 32-byte symmetric key sealed inside the already Noise-XX-encrypted IM channel; messages are XSalsa20-Poly1305 secretbox'd and fanned out full-mesh to room members. Conceptually equivalent to gossipsub + a sealed room key, without an extra protocol.
- **Offline mailbox relay** (`/buzz/mailbox/1.0.0`): when a buddy is offline, the sender pushes an anonymous **libsodium sealed-box** envelope (X25519 derived from the recipient's Ed25519 PeerId) to one of the recipient's configured relays. Inside the sealed plaintext is a CBOR `InnerEnvelope` with a domain-separated Ed25519 signature so the recipient verifies authenticity end-to-end. Relays cannot read or forge envelopes; any client can act as a relay (200-envelope-per-recipient cap, 30-day TTL). Recipients periodically poll their relays and ack delivered envelopes so storage is freed.
- **AIM 5.x-style UI** with platform-aware fonts:
  - **macOS**: `Lucida Grande` UI / chat font.
  - **Windows / Linux**: `Tahoma` UI, `Times New Roman` chat font.
  - Override in code via the `skin` pref (`auto` | `mac` | `windows`).
- Sandboxed renderers (`contextIsolation: true`, `sandbox: true`, no `nodeIntegration`), strict CSP, all IPC payloads validated with `zod`.

## Run it

```bash
npm install
npm run dev
```

Then to test peer-to-peer locally, launch a second instance pointing at a different `userData` dir:

```bash
# macOS / Linux example
USER_DATA_DIR=$(mktemp -d) npx electron-vite dev --
```

(or just run the built app from two machines on the same network)

### First-time flow

1. **Sign On** window asks you to create a screen name and passphrase.
2. The Buddy List opens. Click **My Info** to copy your **buddy code** (a base58 PeerId).
3. On the second instance, click **Add Buddy**, paste the code, and give it a display name.
4. Double-click the buddy in the list to open an IM window and chat.

## Project layout

```
src/
  main/                Electron main process
    crypto/            Keystore (Argon2id + libsodium), sealed-box helpers
    db/                SQLCipher schema + repository layer
    p2p/               libp2p node + IM protocol
    ipc/               Typed IPC handlers (zod-validated)
    session.ts         Locked/unlocked app state
    index.ts           Entry: lifecycle + windows
  preload/             contextBridge → typed window.buzz API
  renderer/            React UIs (Vite multi-entry)
    theme/             AIM 5.x stylesheet + platform/skin switcher
    windows/
      SignOn/          Create / unlock identity
      BuddyList/       Buddy list + Add Buddy + My Info
      IM/              1:1 IM window
      Chat/            Multi-party chat room window
  shared/              Cross-process types, IPC channels, zod schemas
```

## Security notes

- All persistent state (buddies, history, prefs) is stored in **SQLCipher** with a key derived from your seed; the DB file is unreadable without your passphrase.
- The libp2p transport authenticates peers cryptographically via **Noise XX**; your **PeerId is your identity** — screen names are local cosmetic aliases.
- Renderers cannot touch Node APIs; everything goes through the typed, schema-validated IPC bridge.

## What's not built yet (planned)

- Auto-update + code signing.
