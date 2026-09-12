import { describe, expect, it } from "vitest";

import PacketReader from "@client/net/binary/packet-reader";
import PacketWriter, { extended } from "@client/net/binary/packet-writer";
import { bigIntToBytesBE, bytesToBigIntBE, modPow } from "@client/net/binary/bigint-bytes";
import { concat, equals, hex } from "@client/net/binary/bytes";

describe("PacketWriter / PacketReader round-trip", () => {
  it("round-trips every scalar type in order", () => {
    const body = new PacketWriter(0x2b)
      .writeUInt8(0xfe)
      .writeUInt16LE(0xbeef)
      .writeInt32LE(-123456)
      .writeInt64LE(-1234567890123n)
      .writeDoubleLE(1234.5678)
      .writeBytes(new Uint8Array([1, 2, 3, 4]))
      .toBytes();

    const r = new PacketReader(body);

    expect(r.readUInt8()).toBe(0x2b);
    expect(r.readUInt8()).toBe(0xfe);
    expect(r.readUInt16LE()).toBe(0xbeef);
    expect(r.readInt32LE()).toBe(-123456);
    expect(r.readInt64LE()).toBe(-1234567890123n);
    expect(r.readDoubleLE()).toBeCloseTo(1234.5678, 9);
    expect([...r.readBytes(4)]).toEqual([1, 2, 3, 4]);
    expect(r.remaining()).toBe(0);
  });

  it("round-trips UTF-16 strings including non-ASCII", () => {
    const names = ["Qwerty", "Тестовый", "", "a b c"];
    const w = new PacketWriter();

    for (const n of names) w.writeStringNullUTF16(n);

    const r = new PacketReader(w.toBytes());
    for (const n of names) expect(r.readStringUTF16()).toBe(n);
    expect(r.remaining()).toBe(0);
  });

  it("writes a null terminator, not just the characters", () => {
    // 6 chars * 2 bytes + 2 terminator
    expect(new PacketWriter().writeStringNullUTF16("Qwerty").length).toBe(14);
  });

  it("grows past the initial capacity (EnterWorld is 105 bytes)", () => {
    const body = new PacketWriter(0x11).writeZeros(104).toBytes();

    expect(body.length).toBe(105);
    expect(body[0]).toBe(0x11);
    expect(body.subarray(1).every((b) => b === 0)).toBe(true);
  });

  it("writeZeros clears reused capacity rather than trusting it", () => {
    const w = new PacketWriter();
    w.writeBytes(new Uint8Array(64).fill(0xaa));
    // the first 64 bytes forced a grow; the next writeZeros lands in freshly allocated space
    w.writeZeros(14);

    const body = w.toBytes();
    expect(body.subarray(64).every((b) => b === 0)).toBe(true);
  });

  /* Regression: every writeXxx used to read this.view / this.bytes BEFORE calling reserve(),
     so the first write that crossed the 64-byte initial capacity went through the stale
     pre-grow view - silent corruption for small writes, RangeError for a 128-byte one. This
     mirrors RequestAuthLogin: 1 + 128 + 4 + 43 = 176 bytes. */
  it("stays correct across every grow boundary (RequestAuthLogin shape)", () => {
    const rsa = new Uint8Array(128).map((_, i) => (i * 7) & 0xff);
    const tail = new Uint8Array(43).map((_, i) => (i + 1) & 0xff);

    const body = new PacketWriter(0x00).writeBytes(rsa).writeInt32LE(0x11223344).writeBytes(tail).toBytes();

    expect(body.length).toBe(176);

    const r = new PacketReader(body);
    expect(r.readUInt8()).toBe(0x00);
    expect([...r.readBytes(128)]).toEqual([...rsa]);
    expect(r.readInt32LE()).toBe(0x11223344);
    expect([...r.readBytes(43)]).toEqual([...tail]);
  });

  it("keeps scalar writes intact when one of them triggers the grow", () => {
    const w = new PacketWriter();

    // 15 int32 = 60 bytes; the 16th and 17th cross the 64-byte boundary
    for (let i = 0; i < 20; i++) w.writeInt32LE(i * 1000);

    const r = new PacketReader(w.toBytes());
    for (let i = 0; i < 20; i++) expect(r.readInt32LE()).toBe(i * 1000);
  });

  it("keeps a UTF-16 string intact across the grow boundary", () => {
    const long = "Qwerty".repeat(20);
    const body = new PacketWriter(0x2b).writeStringNullUTF16(long).writeInt32LE(7).toBytes();

    const r = new PacketReader(body);
    r.readUInt8();
    expect(r.readStringUTF16()).toBe(long);
    expect(r.readInt32LE()).toBe(7);
  });

  it("builds the RequestKeyMapping extended packet as D0 21 00", () => {
    expect([...extended(0x0021).toBytes()]).toEqual([0xd0, 0x21, 0x00]);
  });
});

describe("PacketReader bounds checks", () => {
  it("throws instead of returning undefined past the end", () => {
    const r = new PacketReader(new Uint8Array([1, 2, 3]));

    r.readUInt8();
    expect(() => r.readInt32LE()).toThrow(RangeError);
  });

  it("throws on an unterminated string", () => {
    // "ab" with no 0x0000 terminator
    expect(() => new PacketReader(new Uint8Array([0x61, 0x00, 0x62, 0x00])).readStringUTF16()).toThrow(
      RangeError,
    );
  });

  it("skipInt32 / skipDouble advance by the right stride", () => {
    const body = new PacketWriter().writeInt32LE(1).writeInt32LE(2).writeDoubleLE(3).writeInt32LE(42).toBytes();
    const r = new PacketReader(body);

    r.skipInt32(2).skipDouble(1);
    expect(r.readInt32LE()).toBe(42);
  });
});

describe("byte helpers", () => {
  it("concat joins in order", () => {
    expect([...concat(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))]).toEqual([1, 2, 3]);
  });

  it("equals compares content and length", () => {
    expect(equals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equals(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
  });

  it("hex pads and truncates", () => {
    expect(hex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("00 0f ff");
    expect(hex(new Uint8Array([1, 2, 3, 4]), 2)).toBe("01 02 …(+2)");
  });
});

describe("bigint bytes", () => {
  it("round-trips big-endian", () => {
    const bytes = new Uint8Array(128);
    bytes[0] = 0x01;
    bytes[127] = 0xff;

    expect([...bigIntToBytesBE(bytesToBigIntBE(bytes), 128)]).toEqual([...bytes]);
  });

  it("is big-endian, not little", () => {
    expect(bytesToBigIntBE(new Uint8Array([0x01, 0x00]))).toBe(256n);
  });

  it("throws when the value does not fit", () => {
    expect(() => bigIntToBytesBE(0x1_0000n, 2)).toThrow(RangeError);
  });

  it("modPow matches a hand-computed case", () => {
    expect(modPow(4n, 13n, 497n)).toBe(445n); // classic textbook vector
    expect(modPow(2n, 65537n, 1_000_003n)).toBe(2n ** 65537n % 1_000_003n);
  });
});
