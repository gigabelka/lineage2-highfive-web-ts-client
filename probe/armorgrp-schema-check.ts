/* Runs the *real* `src/assets/unreal/datafile/schema/armorgrp.schema.ts` against the real
   `armorgrp.dat`, offline, with a minimal stand-in for the `UEncodedFile` reader that the containers
   take. Purpose: decide empirically whether the schema in the app fits the file, instead of
   inferring it from a mirror of the reader.

   Usage: npx tsx probe/armorgrp-schema-check.ts [maxRows=40] */
import fs from "node:fs";
import { Inflate } from "pako";
import SCHEMA_ARMORGRP_DAT, {
  armorgrpRowStartsAt,
  CHARACTER_ARMOR_SLOTS,
} from "../src/assets/unreal/datafile/schema/armorgrp.schema";

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

/* The slice of `UEncodedFile` the dat containers actually touch. */
class StubReader {
  public pos = 0;
  public constructor(public readonly data: Buffer) {}
  public tell() { return this.pos; }
  /* mirrors UEncodedFile.seek: relative unless "set" is asked for */
  public seek(n: number, mode: "cur" | "set" = "cur") {
    if (mode === "set") this.pos = n;
    else this.pos += n;
  }
  public read(type: string | number): any {
    if (typeof type === "number") {
      const view = this.data.subarray(this.pos, this.pos + type);
      this.pos += type;
      return view;
    }
    switch (type) {
      case "uint32": { const v = this.data.readUInt32LE(this.pos); this.pos += 4; return v; }
      case "int32": { const v = this.data.readInt32LE(this.pos); this.pos += 4; return v; }
      case "int16": { const v = this.data.readInt16LE(this.pos); this.pos += 2; return v; }
      case "uint16": { const v = this.data.readUInt16LE(this.pos); this.pos += 2; return v; }
      case "uint8": { const v = this.data.readUInt8(this.pos); this.pos += 1; return v; }
      case "float": { const v = this.data.readFloatLE(this.pos); this.pos += 4; return v; }
      case "compat32": {
        let b = this.data.readUInt8(this.pos++);
        const sign = b & 0x80;
        let shift = 6;
        let r = b & 0x3f;
        if (b & 0x40) {
          let n = 1;
          do { if (n++ >= 5) break; b = this.data.readUInt8(this.pos++); r |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        }
        return sign ? -r : r;
      }
      case "utf16": {
        const byteLength = this.data.readUInt32LE(this.pos);
        this.pos += 4;
        if (byteLength > this.data.length - this.pos) throw new Error(`utf16 length ${byteLength} runs past the buffer`);
        const s = this.data.toString("utf16le", this.pos, this.pos + byteLength);
        this.pos += byteLength;
        return s;
      }
      default: throw new Error(`stub does not implement '${type}'`);
    }
  }
}

/* `loadSingleValue` from un-datafile.ts, reduced to what the armour schema uses. */
function loadSingleValue(pkg: StubReader, type: any, values: Record<string, any>): any {
  return typeof type === "string" ? pkg.read(type) : type.read(pkg, values);
}

const data = decryptVer4xx(fs.readFileSync("c:/Games/HighFive/system/armorgrp.dat"));
const rowCount = data.readUInt32LE(0);
const maxRows = Number(process.argv[2] ?? 0);

/* Independent row starts, the same needle `probe/walk-armorgrp.ts` uses: `drop_mesh_1` is the seventh
   field, so its text begins 32 bytes into the row and always names a `dropitems.` mesh. This is the
   ground truth the modelled prefix is checked against - `UDataFile` gets it from `armorgrpRowStartsAt`,
   which the probe cannot use because it reads through a stub. */
const needle = Buffer.from("dropitems.", "utf16le");
const rowStarts: number[] = [];

for (let i = 0; i + needle.length <= data.length; i++)
  if (data[i] === needle[0] && data.subarray(i, i + needle.length).equals(needle))
    rowStarts.push(i - 32);

/* The schema's own "skip the rest of the row" entry needs the file object; the probe supplies the row
   end by hand instead. */
const modelled = SCHEMA_ARMORGRP_DAT.filter(
  (entry) =>
    typeof entry.type === "string" ||
    entry.type.constructor.name !== "RestOfRowContainerType",
);

console.log(`${rowStarts.length} rows found by the needle, recordCount says ${rowCount}`);

let ok = 0;
const failures: string[] = [];
const bodyParts = new Map<number, number>();
const firstMeshColumns = new Map<string, number>();
const skipped = new Map<number, number>();
const limit = maxRows > 0 ? Math.min(maxRows, rowStarts.length) : rowStarts.length;

for (let r = 0; r < limit; r++) {
  const rowStart = rowStarts[r];
  const rowEnd = rowStarts[r + 1] ?? data.length;
  const pkg = new StubReader(data);
  const values: Record<string, any> = {};

  pkg.pos = rowStart;

  try {
    for (const { type, name } of modelled) values[name] = loadSingleValue(pkg, type, values);
  } catch (e) {
    if (failures.length < 3)
      failures.push(`row ${r} @${rowStart} (id ${values.id}): ${(e as Error).message}`);
    continue;
  }

  /* The modelled prefix must fit inside the row the needle found; if it overshoots, the columns are
     being read wrong and every race after the divergence is garbage. */
  if (pkg.tell() > rowEnd) {
    if (failures.length < 3)
      failures.push(
        `row ${r} @${rowStart} (id ${values.id}): modelled prefix ends at ${pkg.tell()} but the row ends at ${rowEnd}`,
      );
    continue;
  }

  ok++;
  bodyParts.set(values.body_part, (bodyParts.get(values.body_part) ?? 0) + 1);
  skipped.set(rowEnd - pkg.tell(), (skipped.get(rowEnd - pkg.tell()) ?? 0) + 1);
  const mesh = values.m_human_fighter_mesh as string[];
  firstMeshColumns.set(JSON.stringify(mesh), (firstMeshColumns.get(JSON.stringify(mesh)) ?? 0) + 1);
}

console.log(`${ok}/${limit} rows read cleanly by the schema's modelled prefix`);
console.log(`failures:\n  ${failures.join("\n  ") || "none"}`);
console.log(`body_part histogram: ${[...bodyParts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(", ")}`);
console.log(`slots the schema looks for: ${JSON.stringify(CHARACTER_ARMOR_SLOTS)}`);
console.log(`unmodelled tail bytes skipped: ${[...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}Bx${v}`).join(", ")}`);
console.log(`m_human_fighter_mesh values seen: ${[...firstMeshColumns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}x${v}`).join("  ")}`);

/* The row oracle is what bounds a row for the app (`RestOfRowContainerType`) *and* what resyncs past a
   row that does not fit, so an oracle that rejects real row starts ends the table early instead of
   skipping one row. Checked here against the needle's own starts, which are ground truth. */
const fakeReadable = {
  readPrimitive: (at: number, length: number) => {
    if (at + length > data.length) throw new Error("out of bounds");
    return new DataView(data.buffer, data.byteOffset + at, length);
  },
} as unknown as Parameters<typeof armorgrpRowStartsAt>[0];

const rejected = rowStarts.filter((at) => !armorgrpRowStartsAt(fakeReadable, at));

console.log(
  `oracle accepts ${rowStarts.length - rejected.length}/${rowStarts.length} real row starts` +
    (rejected.length ? `; first rejects: ${rejected.slice(0, 5).join(", ")}` : ""),
);

/* The one position the app failed to resync from (see the 'failed to decode' warning in the app's
   console). Printing the real starts around it says whether the app scanned past them, and the oracle's
   verdict on each says whether it rejected them. */
const around = Number(process.argv[3] ?? 0);

if (around > 0) {
  const near = rowStarts.filter((at) => at >= around - 200 && at <= around + 40000);

  console.log(`\nstarts within 40KB of ${around}:`);
  for (const at of near.slice(0, 12))
    console.log(`  ${at} (+${at - around}) oracle=${armorgrpRowStartsAt(fakeReadable, at)}`);
}
