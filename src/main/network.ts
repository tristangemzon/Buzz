// Plaintext network-mode config. Persisted at userData/network.json so it can
// be read BEFORE the user unlocks (encrypted prefs are unavailable until the
// passphrase is entered). Contains no secrets — only routing hints.

import path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { app } from 'electron';

import { NetworkConfig } from '@shared/schemas.js';

function configPath(): string {
  return path.join(app.getPath('userData'), 'network.json');
}

export function loadNetworkConfig(): NetworkConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return NetworkConfig.parse(JSON.parse(raw));
  } catch {
    // Missing / corrupt / fails validation → fall back to defaults.
    return NetworkConfig.parse({});
  }
}

export async function saveNetworkConfig(cfg: NetworkConfig): Promise<NetworkConfig> {
  const parsed = NetworkConfig.parse(cfg);
  const file = configPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(parsed, null, 2), 'utf8');
  return parsed;
}

// Extracts the trailing /p2p/<peerid> component from a multiaddr.
export function peerIdFromMultiaddr(addr: string): string | null {
  const m = addr.match(/\/p2p\/([A-Za-z0-9]+)$/);
  return m && m[1] ? m[1] : null;
}
