/* Offline .dat dumper: RSA-decrypts a HighFive system/*.dat and hex-dumps a byte range with both a
   UTF-16 reading and a u32 reading, so a row can be read field by field without the dev server.
   Usage: npx tsx probe/dump-row.ts <file> <offset> <length> [utf16|u32] */
import fs from "node:fs";
import { Inflate } from "pako";

const BLOCK_SIZE = 128;
const RSA_MODULUS_HEX =
  "75b4d6de5c016544068a1acf125869f43d2e09fc55b8b1e289556daf9b8757635593446288b3653da1ce91c87bb1a5c18f16323495c55d7d72c0890a83f69bfd1fd9434eb1c02f3e4679edfa43309319070129c267c85604d87bb65bae205de3707af1d2108881abb567c3b3d069ae67c3a4c6a3aa93d26413d4c66094ae2039";
const RSA_EXPONENT = 0x1dn;

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return r;
}

function decryptVer4xx(raw: Buffer): Buffer {
  const modulus = BigInt(`0x${RSA_MODULUS_HEX}`);
  const encoded = raw.subarray(28);
  const chunks: Buffer[] = [];
  let readOffset = 0;
  let first = true;

  while (readOffset + BLOCK_SIZE < encoded.length) {
    const block = encoded.subarray(readOffset, readOffset + BLOCK_SIZE);
    const decoded = bigIntToBytes(modpow(bytesToBigInt(block), RSA_EXPONENT, modulus), BLOCK_SIZE);
    const size = decoded[3] & 0xff;
    const startPosition = BLOCK_SIZE - size - (((BLOCK_SIZE - 4) - size) % 4);

    chunks.push(
      first
        ? Buffer.from(decoded.subarray(startPosition + 4, startPosition + size))
        : Buffer.from(decoded.subarray(startPosition, startPosition + size)),
    );
    first = false;
    readOffset += startPosition + size;
  }

  const inflate = new Inflate({ raw: false });
  const out: Buffer[] = [];
  inflate.onData = (c) => out.push(Buffer.from(c));
  inflate.push(Buffer.concat(chunks), true);
  return Buffer.concat(out);
}

const file = process.argv[2] ?? "c:/Games/HighFive/system/armorgrp.dat";
const from = Number(process.argv[3] ?? 0);
const length = Number(process.argv[4] ?? 128);
const mode = process.argv[5] ?? "both";

const data = decryptVer4xx(fs.readFileSync(file));
console.log(`${file}: ${data.length} bytes decrypted, first u32 = ${data.readUInt32LE(0)}`);

const to = Math.min(from + length, data.length);

for (let at = from; at < to; at += 16) {
  const end = Math.min(at + 16, to);
  const bytes = [...data.subarray(at, end)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const u32 = data.readUInt32LE(at);
  const utf16 = data.toString("utf16le", at, end).replace(/[^\x20-\x7e]/g, ".");

  console.log(
    `${String(at).padStart(9)}  ${bytes.padEnd(47)}  u32=${String(u32).padStart(11)}  |${utf16}|` +
      (mode === "u32" ? "" : ""),
  );
}
