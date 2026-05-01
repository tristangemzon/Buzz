/**
 * meshTcpTransport — custom libp2p transport for Buzz Mesh (exp-p2p) mode.
 *
 * Dials /ip4/100.x.x.x/tcp/* addresses through a local SOCKS5 proxy exposed
 * by the buzz-mesh Go sidecar. The sidecar routes these connections through
 * the Tailscale tsnet userspace stack, which is not directly accessible to
 * Node.js OS sockets.
 *
 * Inbound connections are handled by the Go sidecar's Tailscale forwarder
 * (Tailscale :meshLibp2pPort → 127.0.0.1:meshLibp2pPort), so this transport
 * provides a no-op listener.
 */

import net from 'net';
import { TypedEventEmitter, transportSymbol } from '@libp2p/interface';
import type {
  Transport,
  Listener,
  ListenerEvents,
  CreateListenerOptions,
  DialTransportOptions,
  Connection,
  MultiaddrConnection,
  Logger,
} from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

// Matches Tailscale 100.x.x.x addresses used in tsnet tailnets.
const TAILSCALE_IP_RE = /^\/ip4\/100\./;

// ── No-op Listener ────────────────────────────────────────────────────────────
// Inbound connections come in via the Go sidecar's Tailscale forwarder to
// localhost:meshLibp2pPort, where the regular @libp2p/tcp transport listens.
// This listener is only registered so libp2p doesn't complain about a missing
// createListener() implementation.

class NoopListener extends TypedEventEmitter<ListenerEvents> implements Listener {
  async listen(_addr: Multiaddr): Promise<void> {}
  getAddrs(): Multiaddr[] { return []; }
  async close(): Promise<void> {}
}

// ── Minimal SOCKS5 client ─────────────────────────────────────────────────────
// RFC 1928 — no auth, IPv4 CONNECT only. ~30 lines, zero extra dependencies.

function socks5Connect(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost);
    socket.once('error', reject);

    let state: 'greeting' | 'connecting' = 'greeting';
    let buf = Buffer.alloc(0);

    socket.once('connect', () => {
      // Send greeting: VER=5, NMETHODS=1, METHOD=0x00 (no auth)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (state === 'greeting' && buf.length >= 2) {
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          socket.destroy();
          return reject(new Error(`SOCKS5 greeting rejected: method=${buf[1]}`));
        }
        buf = Buffer.alloc(0);

        // Send CONNECT request for IPv4 target
        const ip = targetHost.split('.').map(Number);
        const req = Buffer.alloc(10);
        req[0] = 0x05; // VER
        req[1] = 0x01; // CMD=CONNECT
        req[2] = 0x00; // RSV
        req[3] = 0x01; // ATYP=IPv4
        req[4] = ip[0]; req[5] = ip[1]; req[6] = ip[2]; req[7] = ip[3];
        req.writeUInt16BE(targetPort, 8);
        socket.write(req);
        state = 'connecting';

      } else if (state === 'connecting' && buf.length >= 10) {
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          socket.destroy();
          return reject(new Error(`SOCKS5 CONNECT failed: rep=${buf[1]}`));
        }
        // Tunnel is open. Remove our data listener — the caller takes over.
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        resolve(socket);
      }
    });
  });
}

// ── Minimal MultiaddrConnection wrapper ───────────────────────────────────────
// Wraps a net.Socket as a libp2p MultiaddrConnection. Keeps only what
// upgradeOutbound() needs: source (async iterable), sink, timeline, remoteAddr,
// close(), abort(), and log.

function socketToMultiaddrConnection(
  socket: net.Socket,
  remoteAddr: Multiaddr,
): MultiaddrConnection {
  const timeline = { open: Date.now() };

  const maConn: MultiaddrConnection = {
    // Async iterable source: yields Uint8Array chunks from the socket.
    source: (async function* () {
      try {
        for await (const chunk of socket) {
          yield chunk as Uint8Array;
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ECONNRESET' && code !== 'EPIPE') throw err;
      }
    })(),

    // Sink: write each chunk and flush.
    async sink(source: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>) {
      try {
        for await (const chunk of source) {
          const data = chunk instanceof Uint8Array ? chunk : chunk.subarray();
          if (!socket.destroyed) {
            await new Promise<void>((resolve, reject) => {
              const ok = socket.write(data, (err) => {
                if (err) reject(err); else resolve();
              });
              if (!ok) socket.once('drain', resolve);
            });
          }
        }
      } finally {
        if (!socket.destroyed) socket.end();
      }
    },

    remoteAddr,
    timeline,

    async close() {
      if (timeline.close == null) timeline.close = Date.now();
      if (!socket.destroyed) {
        socket.end();
        await new Promise<void>((resolve) => socket.once('close', resolve));
      }
    },

    abort(err: Error) {
      if (timeline.close == null) timeline.close = Date.now();
      socket.destroy(err);
    },

    // libp2p uses this for internal logging; a no-op stub satisfies the interface.
    log: Object.assign(() => {}, {
      error: () => {}, enabled: false, trace: () => {}, namespace: 'buzz:mesh-transport',
      diff: 0, color: 0, log: () => {}, extend: () => ({} as Logger),
    }) as unknown as Logger,
  };

  socket.once('close', () => {
    if (maConn.timeline.close == null) maConn.timeline.close = Date.now();
  });

  return maConn;
}

// ── Transport factory ─────────────────────────────────────────────────────────

export interface MeshTcpComponents {
  // No required components — the transport is self-contained.
}

/**
 * Returns a libp2p transport that dials Tailscale 100.x.x.x addresses through
 * the buzz-mesh SOCKS5 proxy.
 *
 * @param socksPort  The local port the buzz-mesh sidecar's SOCKS5 server is
 *                   listening on (reported as stdout line 3).
 */
export function meshTcpTransport(socksPort: number) {
  return (_components: MeshTcpComponents): Transport => ({
    [Symbol.toStringTag]: '@buzz/mesh-tcp',
    [transportSymbol]: true as const,

    // Only accept dials to Tailscale 100.x.x.x/tcp addresses.
    dialFilter(addrs: Multiaddr[]): Multiaddr[] {
      return addrs.filter((ma) => TAILSCALE_IP_RE.test(ma.toString()));
    },

    // This transport never listens — the Go sidecar forwards inbound connections
    // from Tailscale to the localhost port where @libp2p/tcp is already listening.
    listenFilter(_addrs: Multiaddr[]): Multiaddr[] {
      return [];
    },

    createListener(_opts: CreateListenerOptions): Listener {
      return new NoopListener();
    },

    async dial(ma: Multiaddr, options: DialTransportOptions): Promise<Connection> {
      // Parse IP and port from e.g. /ip4/100.x.x.x/tcp/14001/p2p/Qm...
      const str = ma.toString();
      const parts = str.split('/');
      const ip4Idx = parts.indexOf('ip4');
      const tcpIdx = parts.indexOf('tcp');
      if (ip4Idx === -1 || tcpIdx === -1) {
        throw new Error(`meshTcpTransport: cannot parse multiaddr: ${str}`);
      }
      const targetIp = parts[ip4Idx + 1];
      const targetPort = parseInt(parts[tcpIdx + 1], 10);

      const socket = await socks5Connect('127.0.0.1', socksPort, targetIp, targetPort);

      // Decapsulate the /p2p/... component for the raw connection address.
      const rawAddr = ma.decapsulateCode(421); // 421 = /p2p protocol code

      const maConn = socketToMultiaddrConnection(socket, rawAddr);
      const conn = await options.upgrader.upgradeOutbound(maConn);
      return conn;
    },
  });
}
