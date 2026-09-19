/* Prints the 15 per-race mesh/texture columns of rows matching a body_part, to check where the
   renderable meshes of head/cloak actually live.
   Usage: npx tsx probe/row-columns.ts <bodyPart> [limit] */
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
  let r = 1n; base %= mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
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
    chunks.push(first
      ? Buffer.from(decoded.subarray(startPosition + 4, startPosition + size))
      : Buffer.from(decoded.subarray(startPosition, startPosition + size)));
    first = false;
    readOffset += startPosition + size;
  }
  const inflate = new Inflate({ raw: false });
  const out: Buffer[] = [];
  inflate.onData = (c) => out.push(Buffer.from(c));
  inflate.push(Buffer.concat(chunks), true);
  return Buffer.concat(out);
}

const data = decryptVer4xx(fs.readFileSync("c:/Games/HighFive/system/armorgrp.dat"));

function fstring(at: number): { end: number; value: string } | null {
  if (at + 4 > data.length) return null;
  const len = data.readUInt32LE(at);
  if (len % 2 !== 0 || at + 4 + len > data.length) return null;
  return { end: at + 4 + len, value: data.toString("utf16le", at + 4, at + 4 + len) };
}

function container(at: number): { end: number; items: string[] } | null {
  if (at + 4 > data.length) return null;
  const count = data.readUInt32LE(at);
  if (count > 64) return null;
  let p = at + 4;
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = fstring(p);
    if (!s) return null;
    items.push(s.value);
    p = s.end;
  }
  return { end: p, items };
}

function readRow(at: number) {
  let p = at + 28;
  for (let g = 0; g < 2; g++)
    for (let i = 0; i < 3; i++) {
      const s = fstring(p);
      if (!s) return null;
      p = s.end;
    }
  p += 9 * 4;
  const icons: string[] = [];
  for (let i = 0; i < 5; i++) {
    const s = fstring(p);
    if (!s) return null;
    icons.push(s.value);
    p = s.end;
  }
  p += 7 * 4;
  const ext = fstring(p);
  if (!ext) return null;
  p = ext.end;
  const bodyPart = data.readUInt32LE(p);
  const colStart = p + 4;
  const columns: { mesh: string[]; texture: string[]; block: string }[] = [];
  let q = colStart;
  for (let c = 0; c < 15; c++) {
    const mesh = container(q);
    if (!mesh) break;
    const tex = container(mesh.end);
    if (!tex) break;
    const block = [...data.subarray(tex.end, tex.end + 6)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    columns.push({ mesh: mesh.items, texture: tex.items, block });
    q = tex.end + 22;
  }
  return { id: data.readUInt32LE(at + 4), icon: icons[0] ?? "", bodyPart, columns, columnsEnd: q };
}

const needle = Buffer.from("dropitems.", "utf16le");
const rowStarts: number[] = [];
for (let i = 0; i + needle.length <= data.length; i++) {
  if (data[i] !== needle[0]) continue;
  if (data.subarray(i, i + needle.length).equals(needle)) rowStarts.push(i - 32);
}

const wantBodyPart = Number(process.argv[2] ?? 6);
const limit = Number(process.argv[3] ?? 2);
let shown = 0;

for (const start of rowStarts) {
  if (shown >= limit) break;
  const row = readRow(start);
  if (!row || row.bodyPart !== wantBodyPart) continue;
  shown++;
  console.log(`\n=== row@${start} id=${row.id} body_part=${row.bodyPart} ${row.icon} ===`);
  for (let c = 0; c < row.columns.length; c++) {
    const col = row.columns[c];
    console.log(`  col ${String(c).padStart(2)}: mesh=${JSON.stringify(col.mesh)} tex=${JSON.stringify(col.texture)} block=${col.block}`);
  }
  console.log(`  columns end at ${row.columnsEnd}`);
  for (let i = 0; i < 320; i += 16) {
    const a = row.columnsEnd + i;
    console.log(
      `    ${String(a).padStart(9)}  ${[...data.subarray(a, a + 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}` +
        `  |${data.toString("utf16le", a, a + 16).replace(/[^\x20-\x7e]/g, ".")}|`,
    );
  }
}
if (shown === 0) console.log(`no row with body_part=${wantBodyPart}`);
