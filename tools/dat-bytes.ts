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

  /* A fixed-count run of `utf16` strings with no count prefix on the wire - the donor schema's
     `SizedContainerType("utf16", 5)`. */
  public fixedUtf16(count: number): string[] {
    const out: string[] = [];

    for (let i = 0; i < count; i++) out.push(this.utf16());

    return out;
  }

  /* Same, for floats: `SizedContainerType("float", 5)`. */
  public fixedF32(count: number): number[] {
    const out: number[] = [];

    for (let i = 0; i < count; i++) out.push(this.f32());

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

/* Does `at` sit at a plausible start of the next item-table row? The first seven fields are plain
   uint32 and `drop_mesh_1` always begins at a *fixed* offset from the row start (7 x u32 = 28), so
   the mesh name's length prefix and its text are both checkable without walking the row.
 *
 * This alone is a weak filter - a byte-by-byte scan of weapongrp.dat matches ~234k offsets - so it
 * is only trustworthy as a *successor* check during a walk, where the cursor supplies the position
 * and the oracle only has to notice that the next row does not start where the schema said it did. */
/* Advance past a `utf16` field, or return -1 if it cannot be a valid one. */
function skipUtf16OrFail(data: Buffer, at: number): number {
  if (at + 4 > data.length) return -1;

  const byteLength = data.readUInt32LE(at);

  if (byteLength % 2 !== 0 || at + 4 + byteLength > data.length) return -1;

  return at + 4 + byteLength;
}

function looksLikeItemRowStart(data: Buffer, at: number): boolean {
  if (at + 28 > data.length) return false;

  const id = data.readUInt32LE(at + 4);

  if (id === 0 || id > 10_000_000) return false;

  /* Walk the whole head rather than spot-checking one field: the drop strings are variable, so
     only by consuming them can the fixed-shape fields behind them - which carry the real
     discrimination - be reached. Two containers of zeroes in a row is exactly what a random
     offset looks like, so a lone "is this string an identifier" test matches ~234k offsets on
     weapongrp.dat; adding the numeric fields behind the icons is what collapses that. */
  let p = at + 28;

  for (let i = 0; i < 6; i++) {
    p = skipUtf16OrFail(data, p);
    if (p < 0) return false;
  }

  p += 9 * 4; // the nine HighFive-only uint32 the head carries

  for (let i = 0; i < 5; i++) {
    p = skipUtf16OrFail(data, p);
    if (p < 0) return false;
  }

  if (p + 12 > data.length) return false;

  const durability = data.readInt32LE(p);
  const weight = data.readUInt32LE(p + 4);
  const material = data.readUInt32LE(p + 8);

  return durability >= -1 && durability <= 1_000_000 && weight <= 10_000_000 && material <= 1000;
}

/* Mirrors `src/assets/unreal/datafile/schema/armorgrp.schema.ts`'s group table. */
const CHARACTER_ARMOR_GROUPS = [
  "m_human_fighter",
  "f_human_fighter",
  "m_dark_elf",
  "f_dark_elf",
  "m_dwarf",
  "f_dwarf",
  "m_elf",
  "f_elf",
  "m_human_mystic",
  "f_human_mystic",
  "m_orc_fighter",
  "f_orc_fighter",
  "m_orc_mystic",
  "f_orc_mystic",
];

/* The fifteenth race column. The donor's table has no entry for Kamael (C4 predates the race), so
   the repo's schema carries it as `unknown_mesh`/`unknown_texture` - the names are kept here so the
   two readers stay comparable, but the column is a normal race column (`Kamael.mkamael_m002_g` and
   friends are what `probe/row-columns.ts` reads out of it). `getCharacterArmorGroup` in the worker
   therefore throws `Character armor group 'mkamael' does not exist.` for a Kamael character today. */
const KAMAEL_ARMOR_GROUP = "kamael";

/* Bytes between one race column's texture container and the next column's mesh container. Fixed, but
   only as an empirical fit: `probe/walk-armorgrp.ts` walks 2765 of 2777 rows with this stride, and
   its per-column histogram shows a handful of rows where the next column starts two bytes later. Its
   content is one uint32 `1`, a uint32 `0`, then `00 ff 01 00 00 00 00 00 00 00` - the `0xff` byte
   suggests a flag, so the real shape is probably a conditional struct rather than a fixed 22. Nothing
   the renderer needs lives here (it is the per-race material/attach block), so it is skipped. */
const COLUMN_BLOCK_BYTES = 22;

/* The head `armorgrp.dat` and `weapongrp.dat` both open with. Kept in one place because the two
   files genuinely share it - their first rows agree field for field, differing only in content -
   so a divergence found against one table extends both. */
/* What a traced field records: the offset it *ended* at, and its value. The value is what names
   the divergence on a desync - an offset alone says where the cursor went, not whether what it
   read there was plausible. */
type FieldTrace_T = { at: number; value: unknown };

function readItemHead(r: Reader, trace?: Record<string, FieldTrace_T>) {
  /* When `trace` is supplied, each field records the offset it *ended* at, so a row can be laid
     against a hexdump field by field and the first divergence named exactly. */
  const end = (name: string, value: unknown) => {
    if (trace) trace[name] = { at: r.tell(), value };

    return value;
  };

  const tag = end("tag", r.u32());
  const id = end("id", r.u32());
  const drop_type = end("drop_type", r.u32());
  const drop_anim_type = end("drop_anim_type", r.u32());
  const drop_radius = end("drop_radius", r.u32());
  const drop_height = end("drop_height", r.u32());
  const unknown_0 = end("unknown_0", r.u32());
  const drop_mesh = end("drop_mesh", [r.utf16(), r.utf16(), r.utf16()]);
  const drop_texture = end("drop_texture", [r.utf16(), r.utf16(), r.utf16()]);

  /* Nine uint32 the C4 donor does not have, sitting between `drop_texture_3` and `icon`. Their
     *length* is what matters (36 bytes, identical in armorgrp and weapongrp once the variable
     drop strings before them are accounted for); their meaning is still unknown - on both files'
     first rows they are all zero except the seventh, which is 1. Treating them as nine uint32 is
     what puts `icon` and the fields after it - `durability = -1`, `weight = 1600`,
     `material = 8` on weapongrp's first row, all plausible - exactly where the hexdump says they
     are. */
  const unknown_a = end("unknown_a", [
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
  ]);

  const icon = end("icon", r.fixedUtf16(5));
  const durability = end("durability", r.i32());
  const weight = end("weight", r.u32());
  const material = end("material", r.u32());
  const crystallizable = end("crystallizable", r.u32());
  const property_params = end("property_params", r.u32());

  /* Two uint32 the C4 donor does not have, then the one *variable-length* field of the head. The
     variable one is what made the head look like a plain sequence of uint32: it is a zero-length
     FString on most rows (4 bytes, so a `uint32` read of it returns 0 and looks like a field) and
     carries `icon.time_tab` / `icon.*_panel` on ~600 armorgrp rows. Reading the head as six fixed
     uint32 put `body_part` three words early - on `armorgrp` row 0 that word is 0 (an item with no
     slot) while the true value, 21, sits 12 bytes later, and the 56-column block behind it started
     12 bytes early as a result. See the byte-level derivation in the plan/commit message. */
  const unknown_b0 = end("unknown_b0", r.u32());
  const unknown_b1 = end("unknown_b1", r.u32());
  const icon_ext = end("icon_ext", r.utf16());
  const body_part = end("body_part", r.u32());

  return {
    tag,
    id,
    drop_type,
    drop_anim_type,
    drop_radius,
    drop_height,
    unknown_0,
    drop_mesh,
    drop_texture,
    unknown_a,
    icon,
    durability,
    weight,
    material,
    crystallizable,
    property_params,
    unknown_b0,
    unknown_b1,
    icon_ext,
    body_part,
  };
}

/* Row readers. Each returns the parsed row and must leave `r` positioned exactly at the end of
   the row (checked by the oracle in `cmdRows`, not by the reader itself). */
const SCHEMAS: Record<
  string,
  {
    read: (
      r: Reader,
      trace?: Record<string, FieldTrace_T>,
      data?: Buffer,
    ) => Record<string, unknown>;
    oracle: (data: Buffer, at: number) => boolean;
  }
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

  /* Ported from the C4 donor (`c:/Temp/Lineage2JS-character-controller`, weapongrp.schema.ts) and
     re-derived for HighFive. Container semantics deliberately differ from the donor: the repo's
     `UTF16ContainerType` already reads its own uint32 count, so the donor's separate
     `wpn_mesh_cnt`/`wpn_tex_cnt`/`item_sound_cnt` fields are not on the wire at all and the counts
     come from the arrays' lengths - which is also what drives the donor's `ConditionalType`s. */
  weapongrp: {
    read(r, trace) {
      const head = readItemHead(r, trace);
      const end = <T,>(name: string, value: T): T => {
        if (trace) trace[name] = { at: r.tell(), value };

        return value;
      };

      /* `body_part` comes straight out of the shared head now (27 on the one-handed first row),
         and `handness` follows it immediately. The three uint32 that used to sit here -
         `unknown_b0`/`unknown_b1`/`unknown_b2` plus a conditional fourth keyed on a `body_part` that
         was really the head's first unknown - were compensating for a head that stopped three words
         too early: the "0" they keyed on was `unk0` (0 for weapons, which is why the fit looked
         arbitrary) and the "27" they logged as `unknown_b3` is the real body_part. With the head
         fixed the gap closes on its own. */
      const handness = end("handness", r.u32());

      /* Sized, NOT count-prefixed: HighFive keeps the donor's explicit `wpn_mesh_cnt` field and
         then that many bare strings. Reading these as `UTF16ContainerType` (which would consume
         the first count as an extra element) is what made every row desync after `handness`. */
      const wpn_mesh_cnt = end("wpn_mesh_cnt", r.u32());
      const wpn_mesh = end("wpn_mesh", r.fixedUtf16(wpn_mesh_cnt));
      /* One uint32 *per mesh* between the mesh list and the texture list: `[1]` on the one-handed
         first row, `[2, 1]` on the two-handed row 19. Sizing it by the mesh count is what makes
         `wpn_tex_cnt` land on 1 and 3 respectively and the texture string follow immediately.
         Without it the count is consumed as the first element's length prefix and a one-byte
         string is read instead. */
      const unknown_c = end(
        "unknown_c",
        Array.from({ length: wpn_mesh_cnt }, () => r.u32()),
      );
      const wpn_tex_cnt = end("wpn_tex_cnt", r.u32());
      const wpn_tex = end("wpn_tex", r.fixedUtf16(wpn_tex_cnt));
      const item_sound_cnt = end("item_sound_cnt", r.u32());
      const item_sound = end("item_sound", r.fixedUtf16(item_sound_cnt));
      const drop_sound = end("drop_sound", r.utf16());
      const equip_sound = end("equip_sound", r.utf16());
      const effect = end("effect", r.utf16());
      const random_damage = end("random_damage", r.u32());
      const patt = end("patt", r.u32());
      const matt = end("matt", r.u32());
      const weapon_type = end("weapon_type", r.u32());
      const crystal_type = end("crystal_type", r.u32());
      const critical = end("critical", r.u32());
      const hit_mod = end("hit_mod", r.i32());
      const avoid_mod = end("avoid_mod", r.i32());
      const shield_pdef = end("shield_pdef", r.u32());
      const shield_rate = end("shield_rate", r.u32());
      const speed = end("speed", r.u32());
      const mp_consume = end("mp_consume", r.u32());
      const SS_count = end("SS_count", r.u32());
      const SPS_count = end("SPS_count", r.u32());
      const curvature = end("curvature", r.u32());
      const UNK_2 = end("UNK_2", r.u32());
      const is_hero = end("is_hero", r.i32());
      const UNK_3 = end("UNK_3", r.u32());

      /* Dual-wield / two-handed weapons carry a second copy of these four groups. The donor keys
         that on its `wpn_mesh_cnt` field; with that field collapsed into the container the same
         test is the mesh array's length. */
      const dual = wpn_mesh_cnt === 2;
      const effA = end("effA", r.utf16());
      const effB = end("effB", dual ? r.utf16() : "");
      const junk1A = end("junk1A", r.fixedF32(5));
      const junk1B = end("junk1B", dual ? r.fixedF32(5) : []);
      const rangeA = end("rangeA", r.utf16());
      const rangeB = end("rangeB", dual ? r.utf16() : "");
      const junk2A = end("junk2A", r.fixedF32(6));
      const junk2B = end("junk2B", dual ? r.fixedF32(6) : []);

      /* Ten uint32 that close the row (first row: six -1 then four 0). Found by the row-length
         mismatch, not by the field list: the schema measured row 0 at 994 bytes where the next
         row's `drop_mesh_1` says it must be 1034. Which of them are -1 varies per row. */
      const unknown_d = end(
        "unknown_d",
        Array.from({ length: 10 }, () => r.u32()),
      );

      return {
        ...head,
        handness,
        wpn_mesh_cnt,
        wpn_mesh,
        wpn_tex_cnt,
        wpn_tex,
        item_sound_cnt,
        item_sound,
        drop_sound,
        equip_sound,
        effect,
        random_damage,
        patt,
        matt,
        weapon_type,
        crystal_type,
        critical,
        hit_mod,
        avoid_mod,
        shield_pdef,
        shield_rate,
        speed,
        mp_consume,
        SS_count,
        SPS_count,
        curvature,
        UNK_2,
        is_hero,
        UNK_3,
        effA,
        effB,
        junk1A,
        junk1B,
        rangeA,
        rangeB,
        junk2A,
        junk2B,
        unknown_d,
      };
    },
    oracle: looksLikeItemRowStart,
  },

  /* The repo's `armorgrp.schema.ts` is now the authoritative reader for this table (it is exercised
     directly against the file by `probe/armorgrp-schema-check.ts`), so this entry exists only to dump
     a row's head and race columns quickly while reverse-engineering.

     Layout is NOT the donor's. C4 read four containers per race (`mesh`, `texture`,
     `additional_mesh`, `additional_texture`); HighFive reads `mesh` + `texture` + a gap block after
     every column, for fifteen columns - the fourteen race groups plus Kamael, which the donor has no
     column for and the app's schema names `kamael`. Reading the donor's four containers is what put
     `additional_mesh` on the gap block: its first word (1) read as a count, its second (0) as an empty
     string's length, and its third (`00 ff 01 00`) as a 130816-element container, which is the
     out-of-range throw on row 0.

     The gap is a fixed 22 bytes on ~91% of rows. On the rest it is longer, and a fixed stride reads
     the following columns out of alignment - so rows where it happens show garbage mesh names here.
     The app's schema handles those by finding the next column by shape; this reader deliberately does
     not, so that the two disagreeing is visible. */
  armorgrp: {
    read(r, trace, data) {
      const head = readItemHead(r, trace);
      const end = <T,>(name: string, value: T): T => {
        if (trace) trace[name] = { at: r.tell(), value };

        return value;
      };
      const groups: Record<string, string[]> = {};

      for (const group of [...CHARACTER_ARMOR_GROUPS, KAMAEL_ARMOR_GROUP]) {
        groups[`${group}_mesh`] = end(`${group}_mesh`, r.utf16Array());
        groups[`${group}_texture`] = end(`${group}_texture`, r.utf16Array());
        r.skip(COLUMN_BLOCK_BYTES);
      }

      /* Everything past the race columns - the Kamael column's extra pair, `npc_*`/`accessory_*`, the
         sounds and the scalar tail - is unmodelled, and the C4 donor's shape for it does not fit
         HighFive. The row's end is not needed here: the next row's own start is an exact anchor
         (`drop_mesh_1` opens with `dropitems.` 32 bytes in), so the rest is skipped by finding it. */
      const next = data ? findNextItemRow(data, r.tell()) : -1;

      if (next > r.tell()) end("unreadTailBytes", r.tell());
      if (next > r.tell()) r.skip(next - r.tell());

      return { ...head, ...groups };
    },
    oracle: looksLikeItemRowStart,
  },
};

/* The offset of the next item-table row at or after `from`, found by the anchor every row in both
   armorgrp.dat and weapongrp.dat begins with: `drop_mesh_1` is the seventh field, so its text starts
   32 bytes into the row and always names a `dropitems.` mesh. Exact, where the byte-scan oracle is
   not (~2.6 hits per row). Returns -1 when there is none left. */
function findNextItemRow(data: Buffer, from: number): number {
  const needle = Buffer.from("dropitems.", "utf16le");

  for (let i = from; i + needle.length <= data.length; i++)
    if (data[i] === needle[0] && data.subarray(i, i + needle.length).equals(needle))
      return i - 32;

  return -1;
}

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

/* Traces are printed for every row of a run, and a desync can turn a container into a
   hundred-thousand-element array - serialising that verbatim dumps megabytes for one bad row. Arrays
   past three elements are summarised by their head and length instead. */
function traceValue(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value);
  if (value.length <= 3)
    return `[${value.map((item) => JSON.stringify(item)).join(",")}]`;

  return `[${value.slice(0, 3).map((item) => JSON.stringify(item)).join(",")},...${value.length}]`;
}

function cmdRows(path: string, schemaName: string, fromRow: number, toRow: number) {
  const schema = SCHEMAS[schemaName];

  if (!schema) throw new Error(`unknown schema '${schemaName}' - known: ${Object.keys(SCHEMAS).join(", ")}`);

  const data = decrypt(path);
  const rowCount = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  const r = new Reader(data, 4);

  let i = 0;

  const showTrace = (trace: Record<string, FieldTrace_T>) =>
    Object.entries(trace)
      .map(([k, v]) => `${k}=${traceValue(v.value)}@${v.at}`)
      .join(" ");

  for (; i < rowCount; i++) {
    const start = r.tell();
    const trace: Record<string, FieldTrace_T> = {};
    let row: Record<string, unknown>;

    try {
      row = schema.read(r, trace, data);
    } catch (e) {
      /* The offsets of the fields that *did* read are the whole point of the trace here: they name
         the last field before the layout diverges, which an all-at-once reader cannot report
         because it has nothing to print when it throws. */
      console.log(`row ${i}: threw @${start}: ${(e as Error).message}`);
      console.log(`      last fields OK: ${showTrace(trace)}`);
      break;
    }

    const end = r.tell();
    const ok = i + 1 >= rowCount || schema.oracle(data, end);

    if (i >= fromRow && i <= toRow) {
      /* Every field is printed, because on a desync the useful signal is *which* field is the
         first implausible one - a `tag`/`class`-only line hides that. */
      const fields = Object.entries(row)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");

      console.log(`row ${i} [${start}..${end}) (${end - start}B) ${fields}`);
      console.log(`      offsets: ${showTrace(trace)}`);
      if (!ok) console.log("      <-- ORACLE FAILED: next row does not look like a row start");
    }

    if (!ok) {
      console.log(`desync detected after row ${i}, next row expected @${end}`);
      cmdHex(path, end, 96);
      break;
    }
  }

  console.log(`parsed ${i}/${rowCount} rows`);
}

/* Scan for every offset that satisfies a schema's oracle. Consecutive hits are the row
   boundaries, so the gap between them is the exact byte length each row must reproduce - which is
   the target the schema is reverse-engineered against, and is far easier to aim at than a
   desync offset produced by a half-finished reader. */
function cmdScanRows(path: string, schemaName: string, limit: number) {
  const schema = SCHEMAS[schemaName];

  if (!schema) throw new Error(`unknown schema '${schemaName}' - known: ${Object.keys(SCHEMAS).join(", ")}`);

  const data = decrypt(path);
  const rowCount = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  const hits: number[] = [];

  for (let at = 4; at + 32 < data.length; at++) if (schema.oracle(data, at)) hits.push(at);

  console.log(`${hits.length} oracle hits for ${rowCount} rows (first @${hits[0]}, expect 4)`);

  const gaps = new Map<number, number>();

  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i] - hits[i - 1];

    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }

  console.log("row-length histogram (gap between consecutive hits):");

  for (const [gap, count] of [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 12))
    console.log(`  ${String(gap).padStart(5)}B  x${count}`);

  console.log(`first ${Math.min(limit, hits.length)} hits: ${hits.slice(0, limit).join(", ")}`);
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);

  if (!cmd || !file) {
    console.log(
      "usage: dat-bytes <info|hex|rows> <dat> [args]\n" +
        "  info <dat>\n" +
        "  hex  <dat> <offset> <length>\n" +
        "  rows <dat> <schema> [fromRow=0] [toRow=1e9]\n" +
        "  scanrows <dat> <schema> [printFirst=20]",
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
    case "scanrows":
      return cmdScanRows(path, rest[0], Number(rest[1] ?? 20));
    default:
      throw new Error(`unknown command '${cmd}'`);
  }
}

main();
