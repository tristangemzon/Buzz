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
  //   - 'p2p'    → use DEFAULT_BOOTSTRAP (public DHT)
  //   - 'server' → use [serverAddr] only (custom Buzz server)
  network?: NetworkConfig;
};

export async function createNode(opts: NodeOptions): Promise<Libp2p> {
  const privKey = await generateKeyPairFromSeed('Ed25519', opts.identity.seed);
  const peerId: PeerId = await peerIdFromKeys(privKey.public.bytes, privKey.bytes);

  // Resolve bootstrap list: explicit `bootstrap` wins, else network mode, else default.
  const bootstrapList =
    opts.bootstrap ??
    (opts.network?.mode === 'server' && opts.network.serverAddr
      ? [opts.network.serverAddr]
      : DEFAULT_BOOTSTRAP);

  const node = await createLibp2p({
    peerId,
    addresses: {
      listen: opts.listen ?? ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
    },
    transports: [tcp(), webSockets(), circuitRelayTransport({ discoverRelays: 1 })],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [bootstrap({ list: bootstrapList })],
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
