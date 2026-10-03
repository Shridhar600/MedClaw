// src/runtime/adapters/pairing-code.ts
//
// The only place a pairing code is generated and compared.
//
// The record stores a salted SHA-256 verifier, never the plaintext, so the file, the transcript,
// the diagnostics and the model input can never contain a usable code. The plaintext exists only
// in the return value of `issue()`, which the local CLI displays once after the record commits.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_SYMBOLS,
  type PairingCodePort,
} from '../../ports/owner-state';

const SALT_BYTES = 16;
const VERIFIER_VERSION = 'v1';

function sha256Hex(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/**
 * Unbiased symbol draw by rejection sampling. `randomBytes(n) % 31` would bias the low
 * symbols, which is measurable across enough draws and is not acceptable for a secret.
 */
function drawCode(): string {
  const alphabetLength = PAIRING_CODE_SYMBOLS.length;
  // Largest multiple of the alphabet that fits in a byte; reject the remainder.
  const ceiling = Math.floor(256 / alphabetLength) * alphabetLength;
  const out: string[] = [];
  while (out.length < PAIRING_CODE_LENGTH) {
    const bytes = randomBytes(PAIRING_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= ceiling) continue;
      out.push(PAIRING_CODE_SYMBOLS[byte % alphabetLength]);
      if (out.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

export class CryptoPairingCodePort implements PairingCodePort {
  /**
   * `v1:<saltHex>:<sha256(salt + "\n" + plaintext)>`. Self-describing so the scheme can change
   * without silently mis-verifying existing records.
   */
  issue(): { plaintext: string; verifier: string } {
    const plaintext = drawCode();
    const salt = randomBytes(SALT_BYTES).toString('hex');
    return { plaintext, verifier: this.buildVerifier(salt, plaintext) };
  }

  matches(submission: string, verifier: string): boolean {
    const parts = verifier.split(':');
    if (parts.length !== 3 || parts[0] !== VERIFIER_VERSION) return false;
    const [, saltHex, expectedHex] = parts;
    if (!/^[0-9a-f]{32}$/.test(saltHex) || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;

    const expected = Buffer.from(expectedHex, 'hex');
    const actual = sha256Hex(`${saltHex}\n${normalizeForComparison(submission)}`);
    // Lengths are fixed by the verifier format, so this cannot throw on mismatch.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private buildVerifier(saltHex: string, plaintext: string): string {
    return `${VERIFIER_VERSION}:${saltHex}:${sha256Hex(`${saltHex}\n${plaintext}`).toString('hex')}`;
  }
}

/**
 * Comparison is case- and whitespace-insensitive so a code copied from a terminal or retyped in
 * lower case still works, while remaining an exact 8-symbol match otherwise.
 */
function normalizeForComparison(value: string): string {
  return value.trim().toUpperCase();
}