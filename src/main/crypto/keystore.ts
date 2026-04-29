// Keystore: persists an Ed25519 identity key encrypted with a passphrase.
//
// File format (binary, written to <userData>/keystore.bin):
//   magic   "BUZZ\0\0\0\1"          8 bytes
//   salt    libsodium pwhash salt   16 bytes
//   nonce   secretbox nonce         24 bytes
//   ciphertext = secretbox(plaintext, nonce, derivedKey)
// where plaintext is the raw 32-byte Ed25519 seed (libp2p uses 64-byte
// expanded keys; we re-expand from the seed on unlock).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// libsodium-wrappers-sumo ships a broken ESM build (its .mjs references a
// missing inner libsodium-sumo.mjs). Load via Node's CJS resolver so we get
// the working dist/modules-sumo/libsodium-wrappers.js bundle.
const require_ = createRequire(import.meta.url);
const _sodium: typeof import('libsodium-wrappers-sumo') =
  require_('libsodium-wrappers-sumo').default ?? require_('libsodium-wrappers-sumo');

const MAGIC = new Uint8Array([0x42, 0x55, 0x5a, 0x5a, 0x00, 0x00, 0x00, 0x01]); // "BUZZ\0\0\0\1"

export type Sodium = typeof import('libsodium-wrappers-sumo');

let sodiumReady: Promise<Sodium> | null = null;
export async function sodium(): Promise<Sodium> {
  if (!sodiumReady) {
    sodiumReady = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return sodiumReady;
}

export type IdentityMaterial = {
  // Raw 32-byte Ed25519 seed
  seed: Uint8Array;
  // Public key (32 bytes)
  publicKey: Uint8Array;
  // Full 64-byte secret key (seed-derived, libsodium layout)
  secretKey: Uint8Array;
  // Derived DB key (32 bytes) for SQLCipher
  dbKey: Uint8Array;
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export class Keystore {
  constructor(private readonly file: string) {}

  static at(userDataDir: string): Keystore {
    return new Keystore(path.join(userDataDir, 'keystore.bin'));
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      return false;
    }
  }

  async create(passphrase: string): Promise<IdentityMaterial> {
    if (await this.exists()) {
      throw new Error('Keystore already exists');
    }
    const s = await sodium();
    const seed = s.randombytes_buf(32);
    await this.writeEncrypted(seed, passphrase);
    return this.expand(seed);
  }

  async unlock(passphrase: string): Promise<IdentityMaterial> {
    const blob = await fs.readFile(this.file);
    if (blob.length < MAGIC.length + 16 + 24 + 16) {
      throw new Error('Keystore file is corrupt');
    }
    if (!eq(blob.subarray(0, MAGIC.length), MAGIC)) {
      throw new Error('Bad keystore magic');
    }
    const salt = blob.subarray(MAGIC.length, MAGIC.length + 16);
    const nonce = blob.subarray(MAGIC.length + 16, MAGIC.length + 16 + 24);
    const ct = blob.subarray(MAGIC.length + 16 + 24);

    const s = await sodium();
    const key = s.crypto_pwhash(
      32,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    );

    let plaintext: Uint8Array;
    try {
      plaintext = s.crypto_secretbox_open_easy(ct, nonce, key);
    } catch {
      throw new Error('Wrong passphrase');
    }
    if (plaintext.length !== 32) throw new Error('Decrypted seed has wrong length');
    return this.expand(plaintext);
  }

  private async writeEncrypted(seed: Uint8Array, passphrase: string): Promise<void> {
    const s = await sodium();
    const salt = s.randombytes_buf(16);
    const nonce = s.randombytes_buf(24);
    const key = s.crypto_pwhash(
      32,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    );
    const ct = s.crypto_secretbox_easy(seed, nonce, key);
    const blob = concat(MAGIC, salt, nonce, ct);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, blob, { mode: 0o600 });
  }

  private async expand(seed: Uint8Array): Promise<IdentityMaterial> {
    const s = await sodium();
    const kp = s.crypto_sign_seed_keypair(seed);
    // Derive a separate DB key from the seed via BLAKE2b with a domain tag.
    const dbKey = s.crypto_generichash(32, seed, s.from_string('buzz:dbkey:v1'));
    return {
      seed,
      publicKey: kp.publicKey,
      secretKey: kp.privateKey,
      dbKey,
    };
  }
}
