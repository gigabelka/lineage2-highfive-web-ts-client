/**
 * Big-endian byte <-> BigInt conversion plus modular exponentiation, the whole of what
 * RSA-1024 NO_PADDING needs (see crypto/rsa-crypt.ts). Node's `publicEncrypt` is not
 * available in the browser and a DER-encoded key would be pointless here anyway: with
 * NO_PADDING the operation is literally `m^e mod n`.
 */

export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

export function bigIntToBytesBE(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new RangeError("bigIntToBytesBE: negative value");

  const out = new Uint8Array(length);
  let rest = value;

  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  if (rest !== 0n) throw new RangeError(`bigIntToBytesBE: value does not fit in ${length} bytes`);

  return out;
}

/** Square-and-multiply. e = 65537 is 17 bits, so this is 17 squarings of a 1024-bit number. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new RangeError("modPow: modulus must be positive");
  if (exponent < 0n) throw new RangeError("modPow: negative exponent");

  let result = 1n;
  let acc = base % modulus;
  let exp = exponent;

  while (exp > 0n) {
    if (exp & 1n) result = (result * acc) % modulus;
    acc = (acc * acc) % modulus;
    exp >>= 1n;
  }

  return result;
}
