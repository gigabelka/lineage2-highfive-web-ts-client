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

export {
  ASCFType,
  UTF16ContainerType,
  ASCFArrayContainerType,
  ConditionalContainerType,
  UTF16SizedContainerType,
  SizedContainerType,
  NumberContainerType,
};
