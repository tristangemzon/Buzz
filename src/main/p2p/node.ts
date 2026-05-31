// libp2p host: Noise XX + Yamux + TCP/WS, Bootstrap + mDNS.
//
// Identity is provided by the keystore: we feed the 32-byte seed in as the
// libp2p Ed25519 private key (libp2p uses { Ed25519, secret = seed | pub }
// internally; createFromPrivKey accepts the protobuf-encoded form, but we
// use peer-id-factory's createFromPrivKey + privKey-from-Uint8Array helpers).
//
// Note: kadDHT was removed in v0.9.6 — we never queried it directly, peer
// discovery already runs through Bootstrap + mDNS (LAN) + Tailscale (mesh),
// and dropping it eliminates GHSA-32mq-hpph-xfvr (unbounded PUT_VALUE disk
// exhaustion on DHT server nodes) without forcing a libp2p 2.x migration.

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromKeys } from '@libp2p/peer-id';

import type { IdentityMaterial } from '../crypto/keystore.js';
import type { NetworkConfig } from '@shared/schemas.js';
import { meshTcpTransport } from './mesh-transport.js';

// Tailscale 100.x.x.x addresses are only reachable through the buzz-mesh
// SOCKS5 proxy (tsnet is a userspace VPN; 100.x.x.x is NOT on the host OS
// network stack). Wrapping @libp2p/tcp to exclude these addresses prevents
// libp2p from trying a direct OS-socket dial that would always fail, ensuring
// meshTcpTransport is the sole handler for Tailscale peer addresses.
const TAILSCALE_ADDR_RE = /^\/ip4\/100\./;

function tcpExcludingTailscale() {
  const inner = tcp();
  return (components: Parameters<typeof inner>[0]) => {
    const t = inner(components);
    const origDialFilter = t.dialFilter.bind(t);
    t.dialFilter = (addrs) =>
      origDialFilter(addrs.filter((ma) => !TAILSCALE_ADDR_RE.test(ma.toString())));
    return t;
  };
}

// Default bootstrap nodes. In production you'd run your own — these are public
// IPFS bootstrappers and are fine for a dev build.
const DEFAULT_BOOTSTRAP = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
];

// Fixed TCP port used by libp2p in Buzz Mesh mode. The Go sidecar's Tailscale
// forwarder listens on `:meshLibp2pPort` and forwards to this local port.
export const MESH_LIBP2P_PORT = 14001;

export type NodeOptions = {
  identity: IdentityMaterial;
  listen?: string[];
  bootstrap?: string[];
  // When provided, takes precedence over the default bootstrap list:
  //   - 'p2p'     → use DEFAULT_BOOTSTRAP (public DHT)
  //   - 'server'  → use [serverAddr] only (custom Buzz server)
  //   - 'exp-p2p' → no bootstrap, use meshTcpTransport for Tailscale peers
  network?: NetworkConfig;
  // Explicit IP to announce (used in 'exp-p2p' mode — the Tailscale 100.x.x.x address).
  listenIp?: string;
  // SOCKS5 proxy port exposed by the buzz-mesh sidecar (exp-p2p mode).
  socksPort?: number;
};

export async function createNode(opts: NodeOptions): Promise<Libp2p> {
  const privKey = await generateKeyPairFromSeed('Ed25519', opts.identity.seed);
  const peerId: PeerId = await peerIdFromKeys(privKey.public.bytes, privKey.bytes);

  const isMesh = opts.network?.mode === 'exp-p2p';

  // Resolve bootstrap list: explicit `bootstrap` wins, else network mode, else default.
  // In exp-p2p (mesh) mode we skip public bootstrap — the Tailscale mesh provides
  // direct connectivity and IPFS bootstrappers are not needed.
  const bootstrapList =
    opts.bootstrap ??
    (isMesh
      ? []
      : opts.network?.mode === 'server' && opts.network.serverAddr
        ? [opts.network.serverAddr]
        : DEFAULT_BOOTSTRAP);

  // Local-network discovery via mDNS. Enabled in p2p and exp-p2p modes.
  // Disabled in server mode.
  const peerDiscovery: Array<ReturnType<typeof bootstrap> | ReturnType<typeof mdns>> = [];
  if (bootstrapList.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapList }));
  }
  if (opts.network?.mode !== 'server') {
    peerDiscovery.push(mdns({ interval: 5_000 }));
  }

  // In Buzz Mesh mode:
  //   - Listen on a fixed local port (MESH_LIBP2P_PORT). The Go sidecar's
  //     Tailscale forwarder bridges TS:MESH_LIBP2P_PORT → 127.0.0.1:MESH_LIBP2P_PORT.
  //   - Announce the Tailscale IP so peers know where to reach us.
  //   - Add meshTcpTransport to dial other peers' Tailscale IPs via SOCKS5.
  const listenAddresses: string[] = opts.listen ??
    (isMesh
      ? [`/ip4/0.0.0.0/tcp/${MESH_LIBP2P_PORT}`]
      : ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']);

  const announceAddresses: string[] | undefined =
    isMesh && opts.listenIp
      ? [`/ip4/${opts.listenIp}/tcp/${MESH_LIBP2P_PORT}`]
      : undefined;

  // Transports: in mesh mode add meshTcpTransport (routes 100.x.x.x through
  // SOCKS5) alongside tcpExcludingTailscale (handles inbound from Go forwarder
  // + mDNS LAN peers, but explicitly refuses to dial 100.x.x.x so that only
  // meshTcpTransport handles Tailscale addresses — tsnet is a userspace VPN
  // and 100.x.x.x is not reachable from OS sockets).
  const transports = isMesh && opts.socksPort != null
    ? [meshTcpTransport(opts.socksPort), tcpExcludingTailscale(), webSockets()]
    : isMesh
      ? [tcpExcludingTailscale(), webSockets()]
      : [tcp(), webSockets(), circuitRelayTransport({ discoverRelays: 1 })];

  const node = await createLibp2p({
    peerId,
    addresses: {
      listen: listenAddresses,
      ...(announceAddresses ? { announce: announceAddresses } : {}),
    },
    transports,
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
    },
  });

  return node;
}

export function buddyCodeFor(peerId: PeerId): string {
  // PeerIds already serialize to a stable string (CID base58). We use that as
  // the buddy code; users add buddies by pasting this string.
  return peerId.toString();
}
