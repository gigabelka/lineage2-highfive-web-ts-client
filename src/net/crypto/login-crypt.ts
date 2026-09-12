/**
 * Login-server packet encryption: static-key Blowfish for Init, then the session key from
 * Init for everything else. Verbatim semantics from server-protocol.md.
 */

import { blowfishDecrypt, blowfishEncrypt } from "@client/net/crypto/blowfish";
import { concat } from "@client/net/binary/bytes";
import { NewCrypt } from "@client/net/crypto/new-crypt";

const STATIC_KEY = new Uint8Array([
  0x6b, 0x60, 0xcb, 0x5b, 0x82, 0xce, 0x90, 0xb1, 0xcc, 0x2b, 0x6c, 0x55, 0x6c, 0x6c, 0x6c, 0x6c,
]);

export class LoginCrypt {
  private key: Uint8Array = STATIC_KEY;
  private hasSession = false;

  public setSessionKey(blowfishKey: Uint8Array): void {
    this.key = blowfishKey;
    this.hasSession = true;
  }

  /** Init packet: static-key Blowfish decrypt -> reverse rolling XOR -> drop trailing 8 bytes. */
  public decryptInit(body: Uint8Array): Uint8Array {
    const raw = blowfishDecrypt(body, STATIC_KEY);
    const size = raw.length;
    const xor = raw[size - 8] | (raw[size - 7] << 8) | (raw[size - 6] << 16) | (raw[size - 5] << 24);

    NewCrypt.decXORPass(raw, xor);

    return raw.subarray(0, size - 8);
  }

  /** All packets after Init. */
  public decrypt(body: Uint8Array): Uint8Array {
    if (!this.hasSession) return body;
    return blowfishDecrypt(body, this.key);
  }

  /** Outgoing after the session key is set: pad to 4, add 8 zeros, pad to 8, checksum, encrypt. */
  public encrypt(body: Uint8Array): Uint8Array {
    if (!this.hasSession) return body;

    let buf = body;

    if (buf.length % 4 !== 0) buf = concat(buf, new Uint8Array(4 - (buf.length % 4)));

    buf = concat(buf, new Uint8Array(8));

    if (buf.length % 8 !== 0) buf = concat(buf, new Uint8Array(8 - (buf.length % 8)));

    const raw = buf.slice();
    NewCrypt.appendChecksum(raw);

    return blowfishEncrypt(raw, this.key);
  }
}

export default LoginCrypt;
