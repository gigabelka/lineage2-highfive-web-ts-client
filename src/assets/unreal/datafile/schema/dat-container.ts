import { BufferValue } from "@l2js/core";

const decoderASCF = new TextDecoder("windows-1252");
const decoderUTF16 = new TextDecoder("utf-16");

/* UE2 FString: a compat32 length; positive is ANSI (NUL-terminated), negative UTF-16
   (NUL-terminated, so two bytes per unit); |length| includes the terminator. */
class ASCFType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): string {
    const count = pkg.read("compat32");

    if (count === 0) return "";

    const isUnicode = count < 0;
    const terminatorSize = isUnicode ? 2 : 1;
    const byteLength = (Math.abs(count) - 1) * terminatorSize;
    const view = pkg.read(byteLength);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

    pkg.seek(terminatorSize);

    return (isUnicode ? decoderUTF16 : decoderASCF).decode(bytes);
  }
}

class UTF16ContainerType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): string[] {
    const count = pkg.read("uint32");
    const elements = new Array<string>(count);

    for (let i = 0; i < count; i++) elements[i] = pkg.read("utf16");

    return elements;
  }
}

/**
 * A run of UTF-16 strings whose length is a size, or the value of an earlier field of the
 * same row - chargrp.dat sizes its arrays with cnt_* columns and the body arrays with 4.
 */
class UTF16SizedContainerType implements IDatContainerType {
  public isContainerType = true;

  protected size: number | string;

  public constructor(size: number | string) {
    this.size = size;
  }

  public read(pkg: C.UEncodedFile, values: Record<string, any>): string[] {
    const count =
      typeof this.size === "number" ? this.size : (values[this.size] as number);
    const elements = new Array<string>(count);

    for (let i = 0; i < count; i++) elements[i] = pkg.read("utf16");

    return elements;
  }
}

/** Same sizing rule as [UTF16SizedContainerType], for any primitive or utf16 element. */
class SizedContainerType implements IDatContainerType {
  public isContainerType = true;

  protected dtype: C.ValueTypeNames_T;
  protected size: number | string;

  public constructor(dtype: C.ValueTypeNames_T, size: number | string) {
    this.dtype = dtype;
    this.size = size;
  }

  public read(pkg: C.UEncodedFile, values: Record<string, any>): any[] {
    const count =
      typeof this.size === "number" ? this.size : (values[this.size] as number);
    const elements = new Array<any>(count);

    for (let i = 0; i < count; i++) elements[i] = pkg.read(this.dtype as any);

    return elements;
  }
}

/* tab/LF/CR or printable ASCII only - written without literal control-char regex escapes
   (would trip no-control-regex) by comparing char codes instead of matching a pattern. */
function isPrintableAscii(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    if (code !== 0x09 && code !== 0x0a && code !== 0x0d && (code < 0x20 || code > 0x7e)) return false;
  }

  return true;
}

/** A plausible `utf16` string at `pos`: even byte length, in-bounds, and fully printable. */
function tryReadString(pkg: C.UEncodedFile, pos: number): { str: string; consumed: number } | null {
  let len: number;

  try {
    len = pkg.readPrimitive(pos, 4).getUint32(0, true);
  } catch {
    return null;
  }

  if (len < 0 || len > 4000 || len % 2 !== 0) return null;

  let str: string;

  try {
    str = new TextDecoder("utf-16").decode(pkg.readPrimitive(pos + 4, len));
  } catch {
    return null;
  }

  if (!isPrintableAscii(str)) return null;

  return { str, consumed: 4 + len };
}

/** A plausible `count:uint32` + `count` `utf16` strings run starting at `pos`. */
function tryReadCountedArray(pkg: C.UEncodedFile, pos: number): { items: string[]; consumed: number } | null {
  let count: number;

  try {
    count = pkg.readPrimitive(pos, 4).getUint32(0, true);
  } catch {
    return null;
  }

  if (count < 0 || count > 500) return null;

  let cursor = pos + 4;
  const items: string[] = [];

  for (let i = 0; i < count; i++) {
    const found = tryReadString(pkg, cursor);

    if (!found) return null;

    items.push(found.str);
    cursor += found.consumed;
  }

  return { items, consumed: cursor - pos };
}

/**
 * Looks for a plausible `count:uint32` + `count` `utf16` strings run near `from`, tolerating both a
 * few stray bytes (`byteShift`) and a few whole leading uint32 fields the schema doesn't model
 * (`fieldSkip`) - chargrp.dat has been observed to need both (see ResyncingCountedArrayType's doc
 * comment). Tries the smallest offset first so a clean, already-aligned read always wins.
 */
function findCountedArray(
  pkg: C.UEncodedFile,
  from: number,
  maxFieldSkip: number,
): { items: string[]; totalOffset: number } | null {
  for (let fieldSkip = 0; fieldSkip <= maxFieldSkip; fieldSkip++) {
    for (let byteShift = 0; byteShift <= 4; byteShift++) {
      const pos = from + fieldSkip * 4 + byteShift;
      const found = tryReadCountedArray(pkg, pos);

      if (found) return { items: found.items, totalOffset: pos + found.consumed - from };
    }
  }

  return null;
}

/**
 * chargrp.dat's `hair_mesh`/`hair_tex`/`face_mesh`/`face_tex`/`body_mesh`/`body_tex`/`attack_eff`/
 * `walkanimframe` block does not match the published C4 chargrp.ddf: the `cnt_hm`/`cnt_ht`/`cnt_fm`/
 * `cnt_ft` UINT fields the ddf declares immediately after `face_icon` are not physically present -
 * decrypting the real file and tracing the parser field-by-field shows `utf16` string data (and
 * zero-length-string "empty slot" markers) starting immediately after `face_icon`, running for
 * several KB with no separating count fields, until the genuine `cnt_att` UINT/array pair (which
 * *does* match the ddf) is reached. The exact sub-array boundaries within that span are still
 * unresolved, so this reads the whole ambiguous run as one opaque list of raw strings/empty slots -
 * unblocks decode and preserves byte alignment for every field after it (which does match the ddf)
 * at the cost of not yet exposing hair/face/body mesh-tex pairs or attack_eff/walkanimframe by name.
 *
 * `walkanimframe` (a lone UINT, per the ddf) sits right at the end of this run, and is only
 * distinguishable from one more empty-slot zero when it's actually nonzero: when the loop below
 * stops on a value that isn't a valid empty-slot/string, that value is `walkanimframe` (if it was
 * absorbed as a trailing zero, the loop is already sitting on the real `cnt_att`, or something close
 * enough for `ResyncingCountedArrayType`'s own search to find). Either way this doesn't need to
 * resolve it: the schema's next field (`snd_att`, a `ResyncingCountedArrayType`) searches both byte
 * shifts and whole leading fields to skip, so it finds `cnt_att` on its own regardless of whether
 * `walkanimframe` (or more besides it) is still sitting unconsumed right here.
 */
class RawStringRunType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): string[] {
    const items: string[] = [];

    for (;;) {
      const pos = pkg.tell();
      let len: number;

      try {
        len = pkg.readPrimitive(pos, 4).getUint32(0, true);
      } catch {
        break;
      }

      if (len === 0) {
        pkg.seek(4);
        items.push("");
        continue;
      }

      const found = tryReadString(pkg, pos);

      if (!found) break;

      pkg.seek(found.consumed);
      items.push(found.str);
    }

    return items;
  }
}

/**
 * chargrp.dat's `cnt_att`/`cnt_def`/`cnt_dmg`/`cnth`/`cnt1h`/.../`cntf` count fields are usually
 * followed immediately by their own array (one uint32 count then that many `utf16` strings) - unlike
 * the hair/face/body block above, this part of the file does match the ddf's count-then-array shape.
 * But observed rows deviate from even that: chargrp.dat row 1's hand-to-hand `cnth`/`cnt1h` has two
 * stray bytes between one array and the next count, and row 3's `cnt_att` sits behind extra leading
 * uint32 fields this schema doesn't model at all. Rather than one fixed-width uint32 read, this
 * searches a small window of byte shifts *and* whole leading fields to discard, accepting the first
 * spot where the count is plausible (0-500) and every element it points at decodes as a clean
 * printable `utf16` string - self-healing the same way RawStringRunType finds its own end, so a
 * stray byte or field in one row doesn't cascade into every field after it.
 */
class ResyncingCountedArrayType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): string[] {
    const base = pkg.tell();
    const found = findCountedArray(pkg, base, 4);

    if (found) {
      pkg.seek(found.totalOffset);

      return found.items;
    }

    /* nothing plausible in the search window - read at face value so the real error surfaces */
    const count = pkg.read("uint32");
    const items = new Array<string>(count);

    for (let i = 0; i < count; i++) items[i] = pkg.read("utf16");

    return items;
  }
}

/**
 * Not read from the file at all - fills in a schema field with a fixed placeholder value, for a
 * field the ddf declares but whose real position/shape in the binary isn't known yet (see
 * RawStringRunType's doc comment on chargrp.dat's hair/face/body block). Lets callers that expect
 * the field to exist (by name, e.g. `row.face_mesh.length`) get a clean empty result instead of
 * `undefined`, without pretending the value was actually decoded.
 */
class ConstantValueType<T> implements IDatContainerType {
  public isContainerType = true;

  public constructor(private readonly value: T) {}

  public read(): T {
    return this.value;
  }
}

class NumberContainerType implements IDatContainerType {
  public isContainerType = true;

  protected dtype: BufferValue<any>;

  constructor(dtype: C.ValidTypes_T<any>) {
    this.dtype = new BufferValue(dtype);
  }

  public read(pkg: C.UEncodedFile): number[] {
    const count = pkg.read("uint8");

    if (count === 0) return [];

    const elements = new Array<number>(count);

    for (let i = 0; i < count; i++)
      elements[i] = pkg.read(this.dtype).value as number;

    return elements;
  }
}

export {
  ASCFType,
  UTF16ContainerType,
  UTF16SizedContainerType,
  SizedContainerType,
  NumberContainerType,
  RawStringRunType,
  ResyncingCountedArrayType,
  ConstantValueType,
};
