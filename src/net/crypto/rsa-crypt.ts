/**
 * RSA-1024, NO_PADDING, e = 65537 - the credential blob in RequestAuthLogin.
 *
 * server-protocol.md builds a PKCS#1 DER key and calls node:crypto's publicEncrypt with
 * RSA_NO_PADDING. Neither exists in the browser, and with NO_PADDING the whole operation is
 * literally `m^e mod n`, so the DER detour is dropped: 128 plaintext bytes -> BigInt ->
 * modPow -> 128 ciphertext bytes.
 */

import { bigIntToBytesBE, bytesToBigIntBE, modPow } from "@client/net/binary/bigint-bytes";

const RSA_EXPONENT = 65537n;
const KEY_BYTES = 128;
const LOGIN_OFFSET = 0x5e;
const PASSWORD_OFFSET = 0x6e;
const LOGIN_MAX = 14;
const PASSWORD_MAX = 16;

function writeAscii(target: Uint8Array, offset: number, value: string, what: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    /* A non-ASCII credential would be silently mangled by a naive charCodeAt truncation and
       present as a bare LoginFail with no clue why. */
    if (code > 0x7f) throw new Error(`${what} must be ASCII (offending character at index ${i})`);

    target[offset + i] = code;
  }
}

/** Exactly 128 bytes: login at 0x5E (max 14), password at 0x6E (max 16), zeros elsewhere. */
export function buildCredentialPlaintext(login: string, password: string): Uint8Array {
  const plaintext = new Uint8Array(KEY_BYTES);

  writeAscii(plaintext, LOGIN_OFFSET, login.slice(0, LOGIN_MAX), "L2_USERNAME");
  writeAscii(plaintext, PASSWORD_OFFSET, password.slice(0, PASSWORD_MAX), "L2_PASSWORD");

  return plaintext;
}

export function encryptCredentials(login: string, password: string, modulus: Uint8Array): Uint8Array {
  if (modulus.length !== KEY_BYTES) {
    throw new Error(`RSA modulus must be ${KEY_BYTES} bytes, got ${modulus.length}`);
  }

  const m = bytesToBigIntBE(buildCredentialPlaintext(login, password));
  const n = bytesToBigIntBE(modulus);

  /* The plaintext starts with 0x5E zero bytes, so m < n always holds for a real 1024-bit
     modulus; a failure here means the modulus was not unscrambled. */
  if (m >= n) throw new Error("RSA: plaintext >= modulus (was the modulus unscrambled?)");

  return bigIntToBytesBE(modPow(m, RSA_EXPONENT, n), KEY_BYTES);
}

export default encryptCredentials;
