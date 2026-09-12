import { describe, expect, it } from "vitest";

import { FrameReassembler } from "@client/net/ws-transport";

/** Wraps a body in the on-wire framing: [uint16LE size including itself][body]. */
function frame(...body: number[]): Uint8Array {
  const size = body.length + 2;
  return new Uint8Array([size & 0xff, (size >>> 8) & 0xff, ...body]);
}

function concatAll(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("FrameReassembler", () => {
  it("returns a single whole frame's body without the size prefix", () => {
    const r = new FrameReassembler();
    const out = r.push(frame(0x2e, 0x01, 0x02));

    expect(out).toHaveLength(1);
    expect([...out[0]]).toEqual([0x2e, 0x01, 0x02]);
    expect(r.pending).toBe(0);
  });

  it("splits three frames delivered in one chunk", () => {
    const r = new FrameReassembler();
    const out = r.push(concatAll(frame(1), frame(2, 2), frame(3, 3, 3)));

    expect(out.map((f) => [...f])).toEqual([[1], [2, 2], [3, 3, 3]]);
  });

  it("reassembles a frame split across three chunks", () => {
    const r = new FrameReassembler();
    const whole = frame(0x0b, 0xaa, 0xbb, 0xcc, 0xdd);

    expect(r.push(whole.subarray(0, 1))).toHaveLength(0);
    expect(r.push(whole.subarray(1, 4))).toHaveLength(0);

    const out = r.push(whole.subarray(4));
    expect(out.map((f) => [...f])).toEqual([[0x0b, 0xaa, 0xbb, 0xcc, 0xdd]]);
  });

  it("survives a stream fed one byte at a time", () => {
    const r = new FrameReassembler();
    const stream = concatAll(frame(0x09, 1), frame(0x32, 2, 3), frame(0xd9, 4, 5, 6));
    const collected: number[][] = [];

    for (const byte of stream) {
      for (const f of r.push(new Uint8Array([byte]))) collected.push([...f]);
    }

    expect(collected).toEqual([
      [0x09, 1],
      [0x32, 2, 3],
      [0xd9, 4, 5, 6],
    ]);
    expect(r.pending).toBe(0);
  });

  it("keeps a partial trailing frame buffered across calls", () => {
    const r = new FrameReassembler();
    const out = r.push(concatAll(frame(1), frame(2, 2).subarray(0, 2)));

    expect(out.map((f) => [...f])).toEqual([[1]]);
    expect(r.pending).toBe(2);
  });

  it("handles an empty body (size 2) rather than stalling", () => {
    const r = new FrameReassembler();
    const out = r.push(new Uint8Array([0x02, 0x00]));

    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(0);
  });

  it("ignores empty chunks", () => {
    const r = new FrameReassembler();
    expect(r.push(new Uint8Array(0))).toHaveLength(0);
  });

  it("throws on an impossible size instead of looping forever", () => {
    const r = new FrameReassembler();
    // size 1 cannot exist: the field includes its own two bytes
    expect(() => r.push(new Uint8Array([0x01, 0x00, 0xff]))).toThrow(/desynchronised/);
  });

  it("does not alias the incoming chunk's memory", () => {
    const r = new FrameReassembler();
    const chunk = frame(0x11, 0x22);
    const [body] = r.push(chunk);

    chunk[2] = 0x99;
    expect(body[0]).toBe(0x11);
  });
});
