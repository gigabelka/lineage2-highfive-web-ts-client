/**
 * Login-packet checksum and the reverse rolling-XOR pass.
 * Verbatim from server-protocol.md; it was already Uint8Array-based there.
 */
export const NewCrypt = {
  /** XOR of every 4-byte LE word; written into the last 4 bytes before the trailing pad. */
  appendChecksum(raw: Uint8Array): void {
    const size = raw.length;
    let chk = 0;
    let i; // declared outside the loop: the checksum goes where the loop stopped

    for (i = 0; i < size - 4; i += 4) {
      const w = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16) | (raw[i + 3] << 24);
      chk ^= w;
    }

    raw[i] = chk & 0xff;
    raw[i + 1] = (chk >>> 8) & 0xff;
    raw[i + 2] = (chk >>> 16) & 0xff;
    raw[i + 3] = (chk >>> 24) & 0xff;
  },

  /** Reverse rolling-XOR pass, used only when decrypting the Init packet. */
  decXORPass(raw: Uint8Array, key: number): void {
    const size = raw.length;
    let pos = size - 12;
    let ecx = key;

    while (pos >= 4) {
      let edx = raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16) | (raw[pos + 3] << 24);

      edx ^= ecx;
      ecx = (ecx - edx) | 0; // stay in int32; the original's `& 0xffffffff` is a no-op in JS

      raw[pos] = edx & 0xff;
      raw[pos + 1] = (edx >>> 8) & 0xff;
      raw[pos + 2] = (edx >>> 16) & 0xff;
      raw[pos + 3] = (edx >>> 24) & 0xff;

      pos -= 4;
    }
  },
};

export default NewCrypt;
