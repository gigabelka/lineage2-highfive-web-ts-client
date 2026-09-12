/**
 * The login server scrambles the RSA modulus it puts in Init; unscramble it in this exact
 * order before using it for RSA. Verbatim from server-protocol.md.
 */
export function unscrambleModulus(scrambled: Uint8Array): Uint8Array {
  if (scrambled.length !== 128) {
    throw new Error(`RSA modulus must be 128 bytes, got ${scrambled.length}`);
  }

  const n = scrambled.slice();

  for (let i = 0; i < 0x40; i++) n[0x40 + i] ^= n[i]; // C^-1
  for (let i = 0; i < 4; i++) n[0x0d + i] ^= n[0x34 + i]; // B^-1
  for (let i = 0; i < 0x40; i++) n[i] ^= n[0x40 + i]; // A^-1

  for (let i = 0; i < 4; i++) {
    // D^-1 swap
    const t = n[i];
    n[i] = n[0x4d + i];
    n[0x4d + i] = t;
  }

  return n;
}

export default unscrambleModulus;
