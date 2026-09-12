/*
 * Offline byte oracle for HighFive `.dat` system tables (Npcgrp.dat, EnterEventgrp.dat, ...).
 *
 * Same idea as `tools/ukx-bytes.ts`: decrypt once, then read/print without booting the decode
 * worker. HighFive's `.dat` files are the RSA-encrypted "Ver413" container (not the XOR
 * "Ver111"/"Ver121" one `.utx`/`.usx`/`.u` use), so this tool carries its own small decoder -
 * plain BigInt modpow instead of `gmp-wasm`, since the public exponent is 0x1d (29): five
 * squarings, no big-integer library needed.
 *
 * Usage:
 *   npx tsx tools/dat-bytes.ts info <dat>
 *   npx tsx tools/dat-bytes.ts hex  <dat> <offset> <length>
 *   npx tsx tools/dat-bytes.ts rows <dat> <schema> [fromRow] [toRow]
 *
 * `<schema>` selects one of the row readers defined below (`SCHEMAS`). Each prints one line per
 * row with every field, plus an oracle check against the row that follows: the reader always
 * knows where a row *should* end, and the following row's `tag` (u32) and `class`/first string
 * field are checked for plausibility (small non-negative integer; printable identifier-shaped
 * text) as a desync detector. A schema is source, not data - extend `SCHEMAS` as more of a
 * table's tail is worked out, the same way `walkLodModel` in ukx-bytes.ts grew.
 *
 * Paths are relative to the client install (c:/Games/HighFive) unless absolute.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { Inflate } from "pako";

const CLIENT_ROOT = "c:/Games/HighFive";
const BLOCK_SIZE = 128;

/* Same key `@l2js/core` vendors at vendor/l2js-core/src/crypto/keys/rsa.ts (`encdec`). */
const RSA_MODULUS_HEX =
  "75b4d6de5c016544068a1acf125869f43d2e09fc55b8b1e289556daf9b8757635593446288b3653da1ce91c87bb1a5c18f16323495c55d7d72c0890a83f69bfd1fd9434eb1c02f3e4679edfa43309319070129c267c85604d87bb65bae205de3707af1d2108881abb567c3b3d069ae67c3a4c6a3aa93d26413d4c66094ae2039";
const RSA_EXPONENT = 0x1dn;

function resolvePath(p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.join(CLIENT_ROOT, p);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;

  for (const b of bytes) v = (v << 8n) | BigInt(b);

  return v;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);

  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }

  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;

  base %= mod;

  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }

  return result;
}

/* Mirrors vendor/l2js-core/src/crypto/decryption/decrypt-rsa.ts's RSADecoder.ensureFilled/read,
   with gmp_powm_ui replaced by a plain modpow - the modulus is 1024-bit, the exponent tiny, so
   BigInt is plenty fast for a CLI tool. */
function decryptVer4xx(raw: Buffer): Buffer {
  const modulus = BigInt(`0x${RSA_MODULUS_HEX}`);
  const encoded = raw.subarray(28); // past the "Lineage2Ver413" banner
  const chunks: Buffer[] = [];
  let readOffset = 0;
  let archiveSize = -1;
  let first = true;

  while (readOffset + BLOCK_SIZE < encoded.length) {
    const block = encoded.subarray(readOffset, readOffset + BLOCK_SIZE);
    const decoded = bigIntToBytes(modpow(bytesToBigInt(block), RSA_EXPONENT, modulus), BLOCK_SIZE);
    /* `size` always sits at absolute byte 3 of the decoded 128-byte block - the archiveSize
       header (first block only) lives *inside* the payload region this locates, not before it. */
    const size = decoded[3] & 0xff;
    const startPosition = BLOCK_SIZE - size - (((BLOCK_SIZE - 4) - size) % 4);

    if (first) {
      archiveSize = new DataView(decoded.buffer, decoded.byteOffset + startPosition, 4).getUint32(
        0,
        true,
      );
      chunks.push(Buffer.from(decoded.subarray(startPosition + 4, startPosition + size)));
      first = false;
    } else {
      chunks.push(Buffer.from(decoded.subarray(startPosition, startPosition + size)));
    }

    readOffset += startPosition + size;
  }

  const inflated = new Inflate({ raw: false });

  for (const chunk of chunks) inflated.push(chunk);

  const result = Buffer.from(inflated.result as Uint8Array);

  if (result.byteLength !== archiveSize)
    console.warn(`warning: inflated ${result.byteLength}B, header said ${archiveSize}B`);

  return result;
}

function decrypt(path: string): Buffer {
  const raw = fs.readFileSync(path);
  const banner = raw.toString("utf16le", 0, 28).replace(/\0+$/, "");

  if (!banner.startsWith("Lineage2Ver4"))
    throw new Error(`${path}: banner '${banner}' is not a Ver4xx (RSA) container`);

  return decryptVer4xx(raw);
}

class Reader {
  public constructor(
    public readonly data: Buffer,
    public pos = 0,
  ) {}

  public tell() {
    return this.pos;
  }
  public skip(n: number) {
    this.pos += n;
  }
  public u8() {
    return this.data.readUInt8(this.pos++);
  }
  public u16() {
    const v = this.data.readUInt16LE(this.pos);

    this.pos += 2;

    return v;
  }
  public i32() {
    const v = this.data.readInt32LE(this.pos);

    this.pos += 4;

    return v;
  }
  public u32() {
    const v = this.data.readUInt32LE(this.pos);

    this.pos += 4;

    return v;
  }
  public f32() {
    const v = this.data.readFloatLE(this.pos);

    this.pos += 4;

    return v;
  }

  /* compat32: low 6 bits of byte 0, bit 6 = continuation, bit 7 = sign. Mirrors
     vendor/l2js-core/src/buffer-value.ts's fast path. */
  public compat32(): number {
    let b = this.u8();
    const sign = b & 0x80;
    let shift = 6;
    let r = b & 0x3f;

    if (b & 0x40) {
      let bytesRead = 1;

      do {
        if (bytesRead++ >= 5) break;
        b = this.u8();
        r |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }

    return sign ? -r : r;
  }

  /* UE2 FString: compat32 length, positive=ANSI+NUL, negative=UTF-16+NUL(2B); |length| includes
     the terminator. */
  public ascf(): string {
    const count = this.compat32();

    if (count === 0) return "";

    const isUnicode = count < 0;
    const n = Math.abs(count) - 1;
    const bytes = this.data.subarray(this.pos, this.pos + n * (isUnicode ? 2 : 1));
    const s = isUnicode ? bytes.toString("utf16le") : bytes.toString("latin1");

    this.pos += n * (isUnicode ? 2 : 1) + (isUnicode ? 2 : 1);

    return s;
  }

  /* .dat container string: uint32 byte length, then that many bytes, no terminator. */
  public utf16(): string {
    const byteLength = this.u32();
    const s = this.data.toString("utf16le", this.pos, this.pos + byteLength);

    this.pos += byteLength;

    return s;
  }

  public utf16Array(): string[] {
    const count = this.u32();
    const out: string[] = [];

    for (let i = 0; i < count; i++) out.push(this.utf16());

    return out;
  }

  /* NumberContainerType: compat32 count, then that many of `size`-byte little-endian uints. */
  public numArray(size: 1 | 2 | 4): number[] {
    const count = this.compat32();
    const out: number[] = [];

    for (let i = 0; i < count; i++)
      out.push(size === 1 ? this.u8() : size === 2 ? this.u16() : this.u32());

    return out;
  }

  public ascfArray(): string[] {
    const count = this.u32();
    const out: string[] = [];

    for (let i = 0; i < count; i++) out.push(this.ascf());

    return out;
  }
}

const IDENTIFIER_RE = /^[\x20-\x7e]*$/; // printable ASCII - class/mesh names are ASCII identifiers

/* Does `r` sit at a plausible start of the next Npcgrp row? Used as the oracle for both `rows`
   and any future desync search: check the tag is a small non-negative id, then that the row's
   `class` field decodes to plausible ASCII text without over-reading past the row that follows
   it (a garbled length prefix on `class` would make this read run off into never-never land). */
function looksLikeNpcgrpRowStart(data: Buffer, at: number): boolean {
  if (at + 8 > data.length) return false;

  const tag = data.readUInt32LE(at);

  if (tag < 0 || tag > 200000) return false;

  const classLen = data.readUInt32LE(at + 4);

  if (classLen === 0 || classLen > 128) return false;
  if (at + 8 + classLen > data.length) return false;

  const text = data.toString("utf16le", at + 8, at + 8 + classLen);

  return IDENTIFIER_RE.test(text) && /[A-Za-z]/.test(text);
}

/* Row readers. Each returns the parsed row and must leave `r` positioned exactly at the end of
   the row (checked by the oracle in `cmdRows`, not by the reader itself). */
const SCHEMAS: Record<
  string,
  { read: (r: Reader) => Record<string, unknown>; oracle: (data: Buffer, at: number) => boolean }
> = {
  /* Delta from src/assets/unreal/datafile/schema/npcgrp.schema.ts, derived 2026-09-12 (see
     [[highfive-skeletal-mesh-layout]]-adjacent memory on the .dat poisoning bug):
       - levelLimLo/levelLimHi (two uint32) -> one uint8-counted uint32[] ("dtab2"?)
       - after classLim: a uint32-counted ASCF[] (NPC dialogue/greeting lines), then a uint32.
     Verified against rows 0-2510; row 2511 (tag 25035) is the next known divergence - extend this
     schema, don't rewrite it, as more of the tail is worked out. */
  npcgrp: {
    read(r) {
      const tag = r.u32();
      const klass = r.utf16();
      const mesh = r.utf16();
      const tex1 = r.utf16Array();
      const tex2 = r.utf16Array();
      const dtab = r.numArray(4);
      const npc_speed = r.f32();
      const UNK0 = r.u32();
      const sound1 = r.utf16Array();
      const sound2 = r.utf16Array();
      const sound3 = r.utf16Array();
      const UNK1 = r.u32();
      // UNK1 gates whether the two arrays below are present at all - see the note above the
      // schema map. When UNK1 !== 0 both are absent (zero bytes), not merely empty (one byte
      // each): row 2511 (tag 25035) is the first row with UNK1 === 1.
      const UNK2 = UNK1 === 0 ? r.numArray(4) : [];
      const UNK2b = UNK1 === 0 ? r.numArray(4) : []; // replaces C4's levelLimLo/levelLimHi
      const effect = r.utf16();
      const UNK3 = r.u32();
      const soundRadius = r.f32();
      const soundVolume = r.f32();
      const soundRandom = r.f32();
      const quest = r.u32();
      const classLim = r.u32();
      const dialogue = r.ascfArray(); // HighFive-only tail
      const UNK4 = r.u32(); // HighFive-only tail

      return {
        tag,
        klass,
        mesh,
        tex1,
        tex2,
        dtab,
        npc_speed,
        UNK0,
        sound1,
        sound2,
        sound3,
        UNK1,
        UNK2,
        UNK2b,
        effect,
        UNK3,
        soundRadius,
        soundVolume,
        soundRandom,
        quest,
        classLim,
        dialogue,
        UNK4,
      };
    },
    oracle: looksLikeNpcgrpRowStart,
  },
};

function cmdInfo(path: string) {
  const raw = fs.readFileSync(path);
  const banner = raw.toString("utf16le", 0, 28).replace(/\0+$/, "");
  const data = decrypt(path);
  const rowCount = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);

  console.log(`banner=${banner}`);
  console.log(`raw size=${raw.byteLength}B, inflated=${data.byteLength}B`);
  console.log(`rowCount (first u32) = ${rowCount}`);
}

function cmdHex(path: string, offset: number, length: number) {
  const data = decrypt(path);
  const end = Math.min(offset + length, data.byteLength);

  for (let at = offset; at < end; at += 16) {
    const row = data.subarray(at, Math.min(at + 16, end));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    const i32 = row.length >= 4 ? new DataView(row.buffer, row.byteOffset, 4).getInt32(0, true) : NaN;
    const f32 = row.length >= 4 ? new DataView(row.buffer, row.byteOffset, 4).getFloat32(0, true) : NaN;

    console.log(
      `  ${at.toString().padStart(8)}  ${hex.padEnd(47)}  ${ascii.padEnd(16)} i32=${i32
        .toString()
        .padStart(11)} f=${f32}`,
    );
  }
}

function cmdRows(path: string, schemaName: string, fromRow: number, toRow: number) {
  const schema = SCHEMAS[schemaName];

  if (!schema) throw new Error(`unknown schema '${schemaName}' - known: ${Object.keys(SCHEMAS).join(", ")}`);

  const data = decrypt(path);
  const rowCount = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  const r = new Reader(data, 4);

  let i = 0;

  for (; i < rowCount; i++) {
    const start = r.tell();
    let row: Record<string, unknown>;

    try {
      row = schema.read(r);
    } catch (e) {
      console.log(`row ${i}: threw @${start}: ${(e as Error).message}`);
      break;
    }

    const end = r.tell();
    const ok = i + 1 >= rowCount || schema.oracle(data, end);

    if (i >= fromRow && i <= toRow)
      console.log(`row ${i} [${start}..${end}) (${end - start}B) tag=${row.tag} class=${row.klass} ${ok ? "" : "  <-- ORACLE FAILED, next row does not look like a row start"}`);

    if (!ok) {
      console.log(`desync detected after row ${i}, next row expected @${end}`);
      cmdHex(path, end, 96);
      break;
    }
  }

  console.log(`parsed ${i}/${rowCount} rows`);
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);

  if (!cmd || !file) {
    console.log(
      "usage: dat-bytes <info|hex|rows> <dat> [args]\n" +
        "  info <dat>\n" +
        "  hex  <dat> <offset> <length>\n" +
        "  rows <dat> <schema> [fromRow=0] [toRow=1e9]",
    );
    process.exit(1);
  }

  const path = resolvePath(file);

  switch (cmd) {
    case "info":
      return cmdInfo(path);
    case "hex":
      return cmdHex(path, Number(rest[0]), Number(rest[1] ?? 128));
    case "rows":
      return cmdRows(path, rest[0], Number(rest[1] ?? 0), Number(rest[2] ?? 1e9));
    default:
      throw new Error(`unknown command '${cmd}'`);
  }
}

main();
