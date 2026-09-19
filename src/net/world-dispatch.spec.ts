import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import { dispatchWorldPacket } from "@client/net/world-dispatch";
import { worldEventObjectId } from "@client/net/world-events";

describe("dispatchWorldPacket", () => {
  it("routes each opcode to its own event kind", () => {
    const cases: [Uint8Array, string][] = [
      [new PacketWriter(0x08).writeInt32LE(7).writeInt32LE(0).toBytes(), "delete"],
      [new PacketWriter(0x01).writeInt32LE(7).toBytes(), "revive"],
      [new PacketWriter(0x27).writeInt32LE(7).writeInt32LE(3).toBytes(), "social"],
      [new PacketWriter(0x28).writeInt32LE(7).writeInt32LE(1).writeInt32LE(0).toBytes(), "moveType"],
      [new PacketWriter(0x25).writeInt32LE(7).toBytes(), "combatStance"],
    ];

    for (const [body, kind] of cases) expect(dispatchWorldPacket(body)?.kind).toBe(kind);
  });

  it("reports the objectId every event is about", () => {
    const body = new PacketWriter(0x08).writeInt32LE(268476032).writeInt32LE(0).toBytes();

    expect(worldEventObjectId(dispatchWorldPacket(body)!)).toBe(268476032);
  });

  it("distinguishes AutoAttackStart from AutoAttackStop", () => {
    const start = dispatchWorldPacket(new PacketWriter(0x25).writeInt32LE(1).toBytes());
    const stop = dispatchWorldPacket(new PacketWriter(0x26).writeInt32LE(1).toBytes());

    expect(start).toEqual({ kind: "combatStance", objectId: 1, inCombat: true });
    expect(stop).toEqual({ kind: "combatStance", objectId: 1, inCombat: false });
  });

  it("returns null for the empty body a decayed npc is sent with", () => {
    expect(dispatchWorldPacket(new Uint8Array([0x0c]))).toBeNull();
  });

  it("returns null for an opcode it does not handle", () => {
    // 0x32 UserInfo is handled by the handshake path, never here.
    expect(dispatchWorldPacket(new PacketWriter(0x32).writeInt32LE(1).toBytes())).toBeNull();
  });

  it("propagates a parse failure rather than swallowing it", () => {
    expect(() => dispatchWorldPacket(new Uint8Array([0x31, 1, 2]))).toThrow(RangeError);
  });
});
