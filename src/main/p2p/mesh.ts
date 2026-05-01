// Buzz Mesh sidecar manager.
//
// Spawns the bundled `buzz-mesh` Go binary which uses Tailscale's tsnet
// library to join the shared Buzz tailnet. Once connected, the sidecar
// prints the assigned 100.x.x.x VPN IP to stdout and exposes a tiny
// local HTTP API for status checks and clean shutdown.
//
// Only one sidecar instance exists at a time (singleton). Session.ts
// calls MeshNode.instance.start() on sign-in (exp-p2p mode) and
// MeshNode.instance.stop() on sign-out.

import { spawn, type ChildProcess } from 'child_process';
import { createReadStream, existsSync } from 'fs';
import { chmod } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';

// Auth key endpoint — Cloudflare Worker that issues ephemeral 24h Tailscale
// preauth keys for the shared Buzz tailnet. Never embedded in the binary.
const MESH_KEY_URL = 'https://mesh-key-worker.tristangemzon.workers.dev/v1/key';

// State directory for the tsnet node. Persisted across launches so the sidecar
// can reconnect without a new auth key each time.
function stateDir(): string {
  return path.join(app.getPath('userData'), 'tailscale-state');
}

// Resolve the platform-specific binary path.
// Production: bundled in Resources alongside the app (not inside asar).
// Development: built locally inside buzz-mesh/dist/.
function binaryPath(): string {
  const plat = process.platform; // 'darwin' | 'win32' | 'linux'
  const arch = process.arch;     // 'arm64' | 'x64'

  let name: string;
  if (plat === 'darwin' && arch === 'arm64') {
    name = 'buzz-mesh-darwin-arm64';
  } else if (plat === 'darwin') {
    name = 'buzz-mesh-darwin-amd64';
  } else if (plat === 'win32') {
    name = 'buzz-mesh-windows-amd64.exe';
  } else {
    name = `buzz-mesh-${plat}-amd64`;
  }

  // Production path: electron-builder copies the binaries into Resources.
  const prodPath = path.join(process.resourcesPath ?? '', name);
  if (existsSync(prodPath)) return prodPath;

  // Development path: built by `make all` in buzz-mesh/.
  // import.meta.url resolves to out/main/index.js, so go up 2 levels to reach the project root.
  // Use fileURLToPath to decode %20 and other URL-encoded characters in the path.
  const devPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../buzz-mesh/dist',
    name,
  );
  return devPath;
}

export type MeshStatus =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'connected'; ip: string }
  | { state: 'error'; message: string };

export class MeshNode {
  private static _instance: MeshNode | null = null;

  static get instance(): MeshNode {
    if (!MeshNode._instance) MeshNode._instance = new MeshNode();
    return MeshNode._instance;
  }

  private _status: MeshStatus = { state: 'stopped' };
  private _proc: ChildProcess | null = null;
  private _apiPort: number | null = null;
  private _socksPort: number | null = null;

  get status(): MeshStatus {
    return this._status;
  }

  /** Local SOCKS5 proxy port for routing TCP through Tailscale (available after start()). */
  get socksPort(): number | null {
    return this._socksPort;
  }

  getIp(): string | null {
    return this._status.state === 'connected' ? this._status.ip : null;
  }

  /**
   * Start the sidecar and resolve once the Tailscale VPN is connected.
   * Resolves with the assigned 100.x.x.x IP address.
   * Safe to call multiple times — returns immediately if already connected.
   */
  async start(): Promise<string> {
    if (this._status.state === 'connected') return (this._status as { ip: string }).ip;
    if (this._status.state === 'connecting') {
      // Wait for the pending start to finish.
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this._status.state === 'connected') {
            clearInterval(check);
            resolve((this._status as { ip: string }).ip);
          } else if (this._status.state === 'error') {
            clearInterval(check);
            reject(new Error((this._status as { message: string }).message));
          } else if (this._status.state === 'stopped') {
            clearInterval(check);
            reject(new Error('Mesh sidecar stopped unexpectedly'));
          }
        }, 200);
      });
    }

    this._status = { state: 'connecting' };

    const bin = binaryPath();
    if (!existsSync(bin)) {
      const msg = `Buzz Mesh binary not found at ${bin}. Run 'make all' in buzz-mesh/.`;
      this._status = { state: 'error', message: msg };
      throw new Error(msg);
    }

    // Make executable on macOS/Linux (survives being copied to Resources).
    if (process.platform !== 'win32') {
      await chmod(bin, 0o755).catch(() => undefined);
    }

    // Fetch an auth key only if no persisted state exists yet.
    let authKey = '';
    const statePath = stateDir();
    const hasState = existsSync(path.join(statePath, 'tailscaled.state'));
    if (!hasState) {
      authKey = await this._fetchAuthKey();
    }

    return new Promise<string>((resolve, reject) => {
      const args = [`--state-dir=${statePath}`];
      if (authKey) args.push(`--authkey=${authKey}`);

      const proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._proc = proc;

      let buf = '';
      let ip = '';
      let apiPort = 0;
      let socksPort = 0;

      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          // First line: Tailscale IP (100.x.x.x)
          if (!ip && /^100\.\d+\.\d+\.\d+$/.test(trimmed)) {
            ip = trimmed;
          }
          // Second line: local HTTP API port
          if (!apiPort && ip && /^\d+$/.test(trimmed)) {
            apiPort = parseInt(trimmed, 10);
            this._apiPort = apiPort;
          }
          // Third line: local SOCKS5 proxy port
          if (!socksPort && apiPort && /^\d+$/.test(trimmed)) {
            socksPort = parseInt(trimmed, 10);
            this._socksPort = socksPort;
          }
          // Once we have all three, we're connected.
          if (ip && apiPort && socksPort) {
            this._status = { state: 'connected', ip };
            resolve(ip);
          }
        }
      });

      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (data: string) => {
        // Log stderr in dev but don't treat as fatal — tsnet emits some noise.
        if (process.env.NODE_ENV !== 'production') {
          process.stderr.write(`[buzz-mesh] ${data}`);
        }
      });

      proc.on('error', (err) => {
        this._status = { state: 'error', message: err.message };
        this._proc = null;
        reject(err);
      });

      proc.on('exit', (code) => {
        if (this._status.state === 'connecting') {
          const msg = `Mesh sidecar exited with code ${code} before connecting`;
          this._status = { state: 'error', message: msg };
          reject(new Error(msg));
        } else if (this._status.state !== 'stopped') {
          this._status = { state: 'stopped' };
        }
        this._proc = null;
        this._apiPort = null;
        this._socksPort = null;
      });
    });
  }

  /**
   * Ask the sidecar to shut down cleanly, then wait for the process to exit.
   */
  async stop(): Promise<void> {
    if (this._status.state === 'stopped') return;
    this._status = { state: 'stopped' };

    if (this._apiPort) {
      try {
        // Best-effort shutdown request; the process exits after receiving it.
        await fetch(`http://127.0.0.1:${this._apiPort}/shutdown`).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }

    if (this._proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this._proc?.kill('SIGKILL');
          resolve();
        }, 3_000);
        this._proc!.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    this._proc = null;
    this._apiPort = null;
    this._socksPort = null;
  }

  /**
   * Fetch the list of other Buzz-mesh Tailscale peer IPs from the sidecar's
   * LocalAPI. Returns an empty array if the sidecar is not running.
   */
  async fetchTailnetPeers(): Promise<string[]> {
    if (!this._apiPort) return [];
    try {
      const res = await fetch(`http://127.0.0.1:${this._apiPort}/peers`);
      if (!res.ok) return [];
      return (await res.json()) as string[];
    } catch {
      return [];
    }
  }

  /** POST to the Cloudflare Worker to obtain a fresh ephemeral preauth key. */
  private async _fetchAuthKey(): Promise<string> {
    const res = await fetch(MESH_KEY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Include a simple identifier so the Worker can rate-limit per tailnet slot.
      body: JSON.stringify({ client: 'buzz', platform: process.platform }),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch Buzz Mesh auth key: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { key?: string };
    if (!body.key) throw new Error('Buzz Mesh auth key response missing "key" field');
    return body.key;
  }
}
