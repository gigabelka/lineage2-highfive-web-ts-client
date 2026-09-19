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

/** A run of ASCF strings, uint32-counted (e.g. Npcgrp.dat's HighFive-only NPC dialogue lines). */
class ASCFArrayContainerType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): string[] {
    const count = pkg.read("uint32");
    const elements = new Array<string>(count);

    for (let i = 0; i < count; i++) elements[i] = new ASCFType().read(pkg);

    return elements;
  }
}

/**
 * Wraps another container, read only when an earlier field of the same row equals
 * `whenFieldEquals` - otherwise the field is absent from the row entirely (zero bytes), not
 * merely empty. Npcgrp.dat's HighFive rows carry a flag (named `UNK1` in the schema) that gates
 * two arrays this way: present when the flag is 0, absent for every other value observed so far.
 */
class ConditionalContainerType implements IDatContainerType {
  public isContainerType = true;

  protected field: string;
  protected whenFieldEquals: number;
  protected inner: IDatContainerType;

  public constructor(field: string, whenFieldEquals: number, inner: IDatContainerType) {
    this.field = field;
    this.whenFieldEquals = whenFieldEquals;
    this.inner = inner;
  }

  public read(pkg: C.UEncodedFile, values: Record<string, any>): any {
    return values[this.field] === this.whenFieldEquals ? this.inner.read(pkg, values) : [];
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

class NumberContainerType implements IDatContainerType {
  public isContainerType = true;

  protected dtype: BufferValue<any>;

  constructor(dtype: C.ValidTypes_T<any>) {
    this.dtype = new BufferValue(dtype);
  }

  public read(pkg: C.UEncodedFile): number[] {
    /* compat32, not uint8: the reference reads this count the same way as every other array in
       the format. Every count observed here so far has been small (2-6), so this was never wrong
       in practice, but a uint8 cap silently misreads anything at/above 0x40 (the compat32
       continuation bit). */
    const count = pkg.read("compat32");

    if (count === 0) return [];

    const elements = new Array<number>(count);

    for (let i = 0; i < count; i++)
      elements[i] = pkg.read(this.dtype).value as number;

    return elements;
  }
}

/**
 * Skips from just after one race column's texture container to the start of the next race column.
 *
 * armorgrp.dat puts a block there whose length is 22 bytes on 86% of rows and two bytes longer on the
 * rest (`probe/armorgrp-schema-check.ts` measures 2376 of 2777 rows at the fixed stride). A fixed
 * stride therefore reads the following column out of alignment and then every race after it, on one
 * row in seven. So the length is found by *shape* instead of by size: a race column is a
 * `uint32`-counted UTF-16 mesh container followed by the same for its texture, and a candidate only
 * counts when both parse. The common stride is tried first, so rows that do fit it are read exactly as
 * they were measured, and the scan only runs where the fixed stride fails.
 *
 * A column that is empty for every race is legitimate (Kamael-only and old low-tier items), so an
 * empty mesh is accepted - but only after every candidate with a real mesh has been ruled out, because
 * the gap block's own zero padding is shaped like an empty container.
 */
class RaceColumnGapContainerType implements IDatContainerType {
  public isContainerType = true;

  /** The measured common stride, agreed on by both armorgrp probes. */
  protected static readonly COMMON_GAP = 22;
  /** How far past the common stride a block has been seen to run. */
  protected static readonly MAX_GAP = 64;
  /** A single-item "whole set" column carries four meshes; this is slack above that. */
  protected static readonly MAX_ELEMENTS = 16;
  /** The longest race mesh name observed is under 60 bytes; this is slack, not a measurement. */
  protected static readonly MAX_STRING_BYTES = 1024;
  /** Every string in a race column is `Package.Object` and nothing else. */
  protected static readonly IDENTIFIER_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

  public read(pkg: C.UEncodedFile): number {
    const stream = pkg as unknown as { tell(): number; seek(pos: number, mode: string): void };
    const start = stream.tell();
    const limit = RaceColumnGapContainerType.MAX_GAP;
    /* the common stride first, then every other offset in order */
    const order = [RaceColumnGapContainerType.COMMON_GAP];

    for (let gap = 0; gap <= limit; gap++)
      if (gap !== RaceColumnGapContainerType.COMMON_GAP) order.push(gap);

    for (const requireMesh of [true, false])
      for (const gap of order) {
        if (!this.columnStartsAt(pkg, start + gap, requireMesh)) continue;

        stream.seek(start + gap, "set");

        return gap;
      }

    throw new Error(`no race column starts within ${limit} bytes of ${start}`);
  }

  /**
   * True when `at` reads as a mesh container. `requireMesh` demands at least one non-empty name, which
   * is what separates a real column from the gap block's padding: the block opens with the same
   * `count 1` / empty-string pair a genuinely empty column does, so an empty mesh cannot be accepted
   * on its own. The texture container behind the mesh is deliberately *not* required - it was, and it
   * turned out to reject rows whose race meshes are all one texture short of the others.
   */
  protected columnStartsAt(pkg: C.UEncodedFile, at: number, requireMesh: boolean): boolean {
    const stream = pkg as unknown as { tell(): number; seek(pos: number, mode: string): void };

    try {
      stream.seek(at, "set");
      const meshes = this.peekStrings(pkg);

      if (meshes === null) return false;

      return !requireMesh || meshes.some((mesh) => mesh !== "");
    } catch {
      /* a candidate near the buffer's end reads past it - not a column */
      return false;
    }
  }

  /**
   * Reads one `uint32`-counted run of UTF-16 strings and returns them, or null when the bytes cannot
   * be that. Leaves the cursor past the run; callers reposition it themselves.
   */
  protected peekStrings(pkg: C.UEncodedFile): string[] | null {
    const count = pkg.read("uint32");

    /* zero is what the block's padding reads as, and no race column has one */
    if (count === 0 || count > RaceColumnGapContainerType.MAX_ELEMENTS) return null;

    const out: string[] = [];

    for (let i = 0; i < count; i++) {
      const byteLength = pkg.read("uint32");

      if (byteLength === 0) {
        out.push("");
        continue;
      }
      if (
        byteLength % 2 !== 0 ||
        byteLength > RaceColumnGapContainerType.MAX_STRING_BYTES
      )
        return null;

      const view = pkg.read(byteLength);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = new TextDecoder("utf-16le").decode(bytes);

      if (!RaceColumnGapContainerType.IDENTIFIER_RE.test(text)) return null;

      out.push(text);
    }

    return out;
  }
}

/**
 * Consumes whatever is left of the current row, using the file's resync oracle to find where the next
 * row starts. This lets a table whose *tail* is not modelled yet still decode: the modelled prefix is
 * kept and only the unread remainder is skipped, where a plain misread would throw and cost the whole
 * row (and, without an oracle, the whole table).
 *
 * It is the one container that reaches back into its reader - it needs the oracle `UDataFile` holds -
 * so it only works inside a `UDataFile` constructed with `resync`.
 */
class RestOfRowContainerType implements IDatContainerType {
  public isContainerType = true;

  public read(pkg: C.UEncodedFile): number {
    const file = pkg as unknown as {
      tell(): number;
      seek(pos: number, mode: string): void;
      findNextRow(from: number): number | null;
    };
    const from = file.tell();
    const next = file.findNextRow(from + 1);

    if (next === null)
      throw new Error(
        `no row start found after ${from}: cannot skip the rest of the row without a resync oracle`,
      );

    file.seek(next, "set");

    return next - from;
  }
}

export {
  ASCFType,
  UTF16ContainerType,
  ASCFArrayContainerType,
  ConditionalContainerType,
  UTF16SizedContainerType,
  SizedContainerType,
  NumberContainerType,
  RaceColumnGapContainerType,
  RestOfRowContainerType,
};
