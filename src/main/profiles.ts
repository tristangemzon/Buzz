// Multi-profile support. Each profile has its own keystore + encrypted DB
// living under userData/profiles/<id>/.
//
// The profile registry itself is a tiny plaintext JSON file at
// userData/profiles.json. It contains only the public, non-sensitive index
// (id + display screen name + createdAt). The keystore inside each profile
// dir is still passphrase-encrypted exactly as before — nothing here weakens
// the security model.

import path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { z } from 'zod';

export const ProfileSummary = z.object({
  id: z.string().uuid(),
  screenName: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
  mesh: z.boolean().default(false),
  /** Set for profiles tied to a Hive server account (the wss:// URL). */
  serverUrl: z.string().max(512).optional(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

const Index = z.object({
  profiles: z.array(ProfileSummary).default([]),
});
type Index = z.infer<typeof Index>;

function userData(): string {
  return app.getPath('userData');
}

function indexPath(): string {
  return path.join(userData(), 'profiles.json');
}

function profilesRoot(): string {
  return path.join(userData(), 'profiles');
}

export function profileDir(id: string): string {
  return path.join(profilesRoot(), id);
}

function readIndex(): Index {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8');
    return Index.parse(JSON.parse(raw));
  } catch {
    return { profiles: [] };
  }
}

function writeIndex(idx: Index): void {
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(idx, null, 2), 'utf8');
}

export function listProfiles(): ProfileSummary[] {
  return readIndex().profiles.slice().sort((a, b) => a.createdAt - b.createdAt);
}

export function getProfile(id: string): ProfileSummary | null {
  return readIndex().profiles.find((p) => p.id === id) ?? null;
}

export function addProfile(screenName: string, mesh = false, serverUrl?: string): ProfileSummary {
  const idx = readIndex();
  const profile: ProfileSummary = {
    id: randomUUID(),
    screenName,
    createdAt: Date.now(),
    mesh,
    serverUrl,
  };
  idx.profiles.push(profile);
  writeIndex(idx);
  fs.mkdirSync(profileDir(profile.id), { recursive: true });
  return profile;
}

export function updateProfile(id: string, patch: Partial<Omit<ProfileSummary, 'id'>>): void {
  const idx = readIndex();
  const i = idx.profiles.findIndex((p) => p.id === id);
  if (i < 0) return;
  idx.profiles[i] = { ...idx.profiles[i]!, ...patch };
  writeIndex(idx);
}

export function removeProfile(id: string): void {
  const idx = readIndex();
  idx.profiles = idx.profiles.filter((p) => p.id !== id);
  writeIndex(idx);
  // Best-effort recursive delete of the per-profile dir.
  try {
    fs.rmSync(profileDir(id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Find an existing profile for the given server URL + screen name combination.
 * Returns null if not found (e.g. first login from this device).
 */
export function findServerProfile(serverUrl: string, screenName: string): ProfileSummary | null {
  const idx = readIndex();
  return idx.profiles.find(
    (p) => p.serverUrl === serverUrl && p.screenName === screenName,
  ) ?? null;
}

// Wipe all local Buzz state: every profile (keystores + encrypted DBs), the
// profile index, and the plaintext network-mode config. The user must be
// locked before calling this — Session.factoryReset enforces that. Best
// effort: errors per-file are swallowed so a partial reset still proceeds.
export function wipeAll(): void {
  // Drop the profile index.
  try {
    fs.rmSync(indexPath(), { force: true });
  } catch {
    /* ignore */
  }
  // Drop every per-profile dir.
  try {
    fs.rmSync(profilesRoot(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Drop the network-mode config.
  try {
    fs.rmSync(path.join(userData(), 'network.json'), { force: true });
  } catch {
    /* ignore */
  }
}

// Move legacy single-profile install (userData/keystore.bin + buzz.sqlite)
// into a new profile dir so existing users keep their identity & history.
// Idempotent: does nothing if profiles.json already has entries or no legacy
// keystore is present.
export function migrateLegacy(): void {
  const legacyKs = path.join(userData(), 'keystore.bin');
  const legacyDb = path.join(userData(), 'buzz.sqlite');
  if (!fs.existsSync(legacyKs)) return;
  const idx = readIndex();
  if (idx.profiles.length > 0) return;

  // Placeholder name; actual screen name is inside the encrypted DB and will
  // be written into the index after the user's first successful unlock.
  const profile = addProfile('My Account');
  const dir = profileDir(profile.id);
  try {
    fs.renameSync(legacyKs, path.join(dir, 'keystore.bin'));
  } catch {
    /* ignore */
  }
  if (fs.existsSync(legacyDb)) {
    try {
      fs.renameSync(legacyDb, path.join(dir, 'buzz.sqlite'));
    } catch {
      /* ignore */
    }
  }
}
