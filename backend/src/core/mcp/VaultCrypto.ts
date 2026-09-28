/**
 * MIT License
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Ported from OpenMuse packages/integrations/src/vault.ts (versioned
 * AES-256-GCM envelope: version.nonce.tag.ciphertext) into Umbra OS backend.
 *
 * Comparison with CredentialVault (NOT replaced — see
 * src/core/vault/CredentialVault.ts):
 * - CredentialVault is a FILE-BACKED, machine-bound store: scrypt(HWID +
 *   passphrase + DPAPI machine key) + v2 envelope + v1 migration. Use it to
 *   PERSIST secrets on this machine.
 * - VaultCrypto here is STATELESS: encryptSecret/decryptSecret wrap a single
 *   string with a caller-supplied 32-byte base64 key. Use it for TRANSPORT
 *   (e.g. Google OAuth tokens, MCP API keys in transit, encrypted backups)
 *   and then store the ciphertext (or the key) via CredentialVault.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== key) {
    throw new Error('Credential encryption requires a 32-byte base64 key');
  }
  return bytes;
}

/** Versioned AES-256-GCM envelope: version.nonce.tag.ciphertext. */
export function encryptSecret(plaintext: string, key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(key), nonce);
  cipher.setAAD(Buffer.from('openmuse:credential:v1'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encrypted: string, key: string): string {
  const keyBytes = decodeKey(key);
  const [version, nonceString, tagString, ciphertextString, extra] = encrypted.split('.');
  if (
    version !== 'v1' ||
    nonceString === undefined ||
    tagString === undefined ||
    ciphertextString === undefined ||
    extra !== undefined
  ) {
    throw new Error('Invalid encrypted secret');
  }
  const encoded = [nonceString, tagString, ciphertextString];
  const [nonce, tag, ciphertext] = encoded.map((value) => Buffer.from(value, 'base64url'));
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    encoded.some(
      (value, index) => Buffer.from(value, 'base64url').toString('base64url') !== encoded[index],
    )
  ) {
    throw new Error('Invalid encrypted secret');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes, nonce);
    decipher.setAAD(Buffer.from('openmuse:credential:v1'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Unable to authenticate or decrypt credential');
  }
}

export function generateVaultKey(): string {
  return randomBytes(32).toString('base64');
}
