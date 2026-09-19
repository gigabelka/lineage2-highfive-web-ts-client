import { BufferValue } from "@l2js/core";
import { describe, expect, it } from "vitest";

/*
 * Pins the framing of `@l2js/core`'s `char` reader, which is what every UE2 name table is built
 * from. A miscount here of a single byte does not throw - it silently shifts the whole name table
 * from that entry onward, so every class, material, bone and animation-sequence name after it is
 * wrong. That is exactly what happened with HighFive's Korean (UTF-16) names: a negative length
 * was read as "zero characters", consuming 1 byte instead of `2 * |length|`, which made
 * `LineageWeapons.ukx` report its 611 SkeletalMesh exports as `Package.Shader`/`Package.FinalBlend`
 * and would have mis-named every weapon bone.
 *
 * The length prefix is written here by hand rather than through a shared helper, so this test
 * fails on a layout change instead of agreeing with it.
 */
function compat32(value: number): number[] {
  const sign = value < 0;
  let r = Math.abs(value);

  if (r < 0x40) return [sign ? 0x80 | r : r];

  const out: number[] = [0x40 | (r & 0x3f)];

  r >>>= 6;
  while (r >= 0x80) {
    out.push(0x80 | (r & 0x7f));
    r >>>= 7;
  }
  out.push(r);

  if (sign) out[0] |= 0x80;

  return out;
}

function ansi(text: string): number[] {
  // The stored length counts the trailing NUL.
  return [...compat32(text.length + 1), ...[...text].map((c) => c.charCodeAt(0)), 0x00];
}

function utf16(codes: number[]): number[] {
  const bytes = [...compat32(-(codes.length + 1))];

  // The stored magnitude counts the 2-byte wide terminator too.
  for (const code of codes) bytes.push(code & 0xff, (code >> 8) & 0xff);
  bytes.push(0x00, 0x00);

  return bytes;
}

function readAt(bytes: number[]) {
  const buffer = new ArrayBuffer(bytes.length + 8);

  new Uint8Array(buffer).set(bytes);

  const value = new BufferValue(BufferValue.char);
  const consumed = value.readValue(buffer, 0);

  return { string: value.string, consumed };
}

describe("BufferValue<char>", () => {
  it("reads an empty string as just the length prefix", () => {
    // No characters and no terminator on the wire, so nothing beyond the prefix may be consumed.
    expect(readAt([0x00])).toEqual({ string: "", consumed: 1 });
  });

  it("reads a short ANSI string", () => {
    expect(readAt(ansi("None"))).toEqual({ string: "None", consumed: 6 });
  });

  it("reads an ANSI string whose length needs a two-byte prefix", () => {
    const text = "a".repeat(69);
    const bytes = ansi(text);

    // 69 characters need a 2-byte compat32, so the body starts two bytes in, not one.
    expect(bytes.length).toBe(72);
    expect(readAt(bytes)).toEqual({ string: text, consumed: 72 });
  });

  it("reads a UTF-16 string, decoded as UTF-16 rather than as ANSI", () => {
    // The five wide characters that sit at LineageWeapons.ukx name entry 392, where the real
    // package's name table desynced.
    const codes = [0xf8bb, 0x80b7, 0xc4b3, 0x74c7, 0x88c9];
    const { string, consumed } = readAt(utf16(codes));

    expect(string).toBe(codes.map((c) => String.fromCharCode(c)).join(""));
    expect(consumed).toBe(13); // 1-byte prefix + 5 wide chars + 2-byte terminator
  });

  it("reads an empty UTF-16 string as just the wide terminator", () => {
    expect(readAt(utf16([]))).toEqual({ string: "", consumed: 3 });
  });

  it("advances by exactly the encoded size, so a following value stays aligned", () => {
    // Trailing sentinel: if the reader over- or under-consumes by even one byte, the offset it
    // reports lands somewhere else - which is the failure mode this whole file exists to catch.
    const bytes = [...utf16([0x0041, 0x0042]), 0x2a];
    const buffer = new ArrayBuffer(bytes.length + 4);

    new Uint8Array(buffer).set(bytes);

    const consumed = new BufferValue(BufferValue.char).readValue(buffer, 0);

    expect(consumed).toBe(7); // 1-byte prefix + 2 wide chars + 2-byte terminator
    expect(new Uint8Array(buffer)[consumed]).toBe(0x2a);
  });
});
