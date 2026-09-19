/* armorgrp.dat HighFive row model, validated against independently-derived row starts.
   Usage: npx tsx probe/walk-armorgrp.ts [rowOffsetToDump] */
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

type Head_T = {
  id: number;
  dropMesh: string[];
  icon: string;
  durability: number;
  weight: number;
  material: number;
  bodyPart: number;
  iconExt: string;
  colStart: number;
};

/* Head: 7 u32, 3 FStrings, 3 FStrings, 9 u32, 5 FStrings,
   then durability/weight/material/crystallizable/property_params/unk0/unk1,
   then one FString (empty on most rows, `icon.time_tab` and friends otherwise) and body_part. */
function readHead(at: number): Head_T | null {
  if (at + 28 > data.length - 8) return null;
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
  const durability = data.readInt32LE(p);
  const weight = data.readUInt32LE(p + 4);
  const material = data.readUInt32LE(p + 8);
  /* durability, weight, material, crystallizable, property_params, unk0, unk1 - then the one
     variable-length field of the head: an FString that is empty on most rows (4 bytes, which is why
     a `uint32` read of it looked like a field) and carries `icon.time_tab` and friends on others. */
  p += 7 * 4;
  const ext = fstring(p);
  if (!ext) return null;
  p = ext.end;
  if (p + 4 > data.length) return null;
  const bodyPart = data.readUInt32LE(p);
  return {
    id: data.readUInt32LE(at + 4),
    dropMesh: [],
    icon: icons[0] ?? "",
    durability,
    weight,
    material,
    bodyPart,
    iconExt: ext.value,
    colStart: p + 4,
  };
}

/* Independent row starts: `drop_mesh_1` opens with "dropitems." 32 bytes into every row. */
const needle = Buffer.from("dropitems.", "utf16le");
const rowStarts: number[] = [];
for (let i = 0; i + needle.length <= data.length; i++) {
  if (data[i] !== needle[0]) continue;
  if (data.subarray(i, i + needle.length).equals(needle)) rowStarts.push(i - 32);
}

let landed = 0;
const failures: string[] = [];
const bodyParts = new Map<number, number>();
const exts = new Map<string, number>();

for (const start of rowStarts) {
  const head = readHead(start);
  if (head === null) { failures.push(`head null @${start}`); continue; }
  if (head.bodyPart > 200) { failures.push(`body_part ${head.bodyPart} @${start}`); continue; }
  landed++;
  bodyParts.set(head.bodyPart, (bodyParts.get(head.bodyPart) ?? 0) + 1);
  exts.set(head.iconExt, (exts.get(head.iconExt) ?? 0) + 1);
}

console.log(`head model landed ${landed}/${rowStarts.length} rows, failures ${failures.length}`);
console.log(failures.slice(0, 5).join("\n"));
console.log(`body_part histogram: ${[...bodyParts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(", ")}`);
console.log(`iconExt != "": ${[...exts.entries()].filter(([k]) => k).map(([k, v]) => `${k}x${v}`).join(", ") || "none"}`);

/* The 22-byte block after each column's mesh/texture pair, per column, over every landed row. */
console.log(`\n--- per-column 22-byte block variety ---`);
const blockVariants: Map<string, number>[] = Array.from({ length: 15 }, () => new Map());
let walkedRows = 0;
const columnFailures: string[] = [];

for (const start of rowStarts) {
  const head = readHead(start);
  if (head === null || head.bodyPart > 200) continue;
  let p = head.colStart;
  let ok = true;
  for (let c = 0; c < 15; c++) {
    const mesh = container(p);
    if (!mesh) { ok = false; break; }
    const tex = container(mesh.end);
    if (!tex) { ok = false; break; }
    const key = [...data.subarray(tex.end, tex.end + 22)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    blockVariants[c].set(key, (blockVariants[c].get(key) ?? 0) + 1);
    p = tex.end + 22;
  }
  if (ok) walkedRows++;
  else if (columnFailures.length < 3) columnFailures.push(`columns failed @${start}`);
}
console.log(`rows whose 15 columns walked: ${walkedRows}`);
console.log(columnFailures.join("\n"));
for (let c = 0; c < 15; c++) {
  const entries = [...blockVariants[c].entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  col ${String(c).padStart(2)}: ${entries.length} distinct; top: ${entries.slice(0, 2).map(([k, v]) => `x${v} [${k}]`).join("  ")}`);
}

const dumpAt = Number(process.argv[2] ?? 0);
if (dumpAt > 0) {
  const head = readHead(dumpAt);
  console.log(`\n=== row@${dumpAt} ===`);
  console.log(JSON.stringify(head, null, 1));
}

/* Name each body_part code by the icon slot token that carries it - the icon says which slot the
   item goes in, independently of any enum, so a code with one token family is that slot. */
console.log(`\n--- body_part by icon slot token ---`);
const byToken = new Map<number, Map<string, number>>();
for (const start of rowStarts) {
  const head = readHead(start);
  if (head === null || head.bodyPart > 200) continue;
  const m = /^icon\.(.+?)_i\d+$/.exec(head.icon);
  if (!m) continue;
  const token = m[1];
  if (!byToken.has(head.bodyPart)) byToken.set(head.bodyPart, new Map());
  const hist = byToken.get(head.bodyPart)!;
  hist.set(token, (hist.get(token) ?? 0) + 1);
}
for (const [bp, hist] of [...byToken.entries()].sort((a, b) => a[0] - b[0])) {
  const total = [...hist.values()].reduce((a, b) => a + b, 0);
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(
    `  body_part=${String(bp).padStart(3)}  rows=${String(total).padStart(4)}  ${top.map(([t, n]) => `${t}x${n}`).join(", ")}`,
  );
}

