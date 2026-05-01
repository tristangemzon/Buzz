// libp2p host: Noise XX + Yamux + TCP/WS, Bootstrap + KadDHT.
//
// Identity is provided by the keystore: we feed the 32-byte seed in as the
// libp2p Ed25519 private key (libp2p uses { Ed25519, secret = seed | pub }
// internally; createFromPrivKey accepts the protobuf-encoded form, but we
// use peer-id-factory's createFromPrivKey + privKey-from-Uint8Array helpers).

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromKeys } from '@libp2p/peer-id';

import type { IdentityMaterial } from '../crypto/keystore.js';
import type { NetworkConfig } from '@shared/schemas.js';

// Default bootstrap nodes. In production you'd run your own — these are public
// IPFS bootstrappers and are fine for a dev build.
const DEFAULT_BOOTSTRAP = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
];

export type NodeOptions = {
  identity: IdentityMaterial;
  listen?: string[];
  bootstrap?: string[];
  // When provided, takes precedence over the default bootstrap list:
  //   - 'p2p'     → use DEFAULT_BOOTSTRAP (public DHT)
  //   - 'server'  → use [serverAddr] only (custom Buzz server)
  //   - 'exp-p2p' → no bootstrap, listen only on the Tailscale VPN IP
  network?: NetworkConfig;
  // Explicit IP to bind to (used in 'exp-p2p' mode — the Tailscale 100.x.x.x address).
  // Overrides the default 0.0.0.0 listen addresses.
  listenIp?: string;
};

export async function createNode(opts: NodeOptions): Promise<Libp2p> {
  const privKey = await generateKeyPairFromSeed('Ed25519', opts.identity.seed);
  const peerId: PeerId = await peerIdFromKeys(privKey.public.bytes, privKey.bytes);

  const isMesh = opts.network?.mode === 'exp-p2p';

  // Resolve bootstrap list: explicit `bootstrap` wins, else network mode, else default.
  // In exp-p2p (mesh) mode we skip public bootstrap entirely — the Tailscale mesh
  // provides full connectivity and the IPFS bootstrappers are not needed.
  const bootstrapList =
    opts.bootstrap ??
    (isMesh
      ? []
      : opts.network?.mode === 'server' && opts.network.serverAddr
        ? [opts.network.serverAddr]
        : DEFAULT_BOOTSTRAP);

  // Local-network discovery via mDNS. Enabled in pure p2p mode and in
  // exp-p2p mode (all tailnet peers appear "local" to libp2p).
  // Disabled in server mode — the Hive server is the rendezvous point.
  const peerDiscovery: Array<ReturnType<typeof bootstrap> | ReturnType<typeof mdns>> = [];
  if (bootstrapList.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapList }));
  }
  if (opts.network?.mode !== 'server') {
    peerDiscovery.push(mdns({ interval: 5_000 }));
  }

  // In exp-p2p mode, bind only to the Tailscale VPN IP so we don't expose
  // ports on public interfaces. Circuit relay is not needed — the tailnet
  // provides direct routing for all peers.
  const listenAddresses: string[] = opts.listen ??
    (isMesh && opts.listenIp
      ? [`/ip4/${opts.listenIp}/tcp/0`, `/ip4/${opts.listenIp}/tcp/0/ws`]
      : ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']);

  const node = await createLibp2p({
    peerId,
    addresses: {
      listen: listenAddresses,
    },
    transports: isMesh
      ? [tcp(), webSockets()]  // No circuit relay on mesh — tailnet is fully routable
      : [tcp(), webSockets(), circuitRelayTransport({ discoverRelays: 1 })],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      dht: kadDHT({ clientMode: true }),
    },
  });

  return node;
}

export function buddyCodeFor(peerId: PeerId): string {
  // PeerIds already serialize to a stable string (CID base58). We use that as
  // the buddy code; users add buddies by pasting this string.
  return peerId.toString();
}
