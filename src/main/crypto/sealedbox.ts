// Sealed-box envelope for the offline mailbox protocol.
//
// Sender encrypts to recipient's X25519 public key using libsodium
// crypto_box_seal, which provides anonymous senders + ciphertext integrity.
// We derive X25519 keys from the recipient's Ed25519 identity key.

import { sodium } from './keystore.js';

export async function ed25519PkToX25519(edPk: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_sign_ed25519_pk_to_curve25519(edPk);
}

export async function ed25519SkToX25519(edSk: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_sign_ed25519_sk_to_curve25519(edSk);
}

export async function sealTo(recipientEdPk: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const xpk = s.crypto_sign_ed25519_pk_to_curve25519(recipientEdPk);
  return s.crypto_box_seal(plaintext, xpk);
}

export async function unseal(
  ciphertext: Uint8Array,
  recipientEdPk: Uint8Array,
  recipientEdSk: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodium();
  const xpk = s.crypto_sign_ed25519_pk_to_curve25519(recipientEdPk);
  const xsk = s.crypto_sign_ed25519_sk_to_curve25519(recipientEdSk);
  return s.crypto_box_seal_open(ciphertext, xpk, xsk);
}
