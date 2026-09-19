import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import {
  parseDeleteObject,
  parseDie,
  parseRevive,
  parseTeleportToLocation,
} from "@client/net/parsers/object-lifecycle";

describe("parseDeleteObject", () => {
  it("reads objectId and ignores the trailing C2 int", () => {
    const body = new PacketWriter(0x08).writeInt32LE(268476032).writeInt32LE(0).toBytes();

    expect(parseDeleteObject(body)).toEqual({ objectId: 268476032 });
  });

  it("throws on a truncated body", () => {
    expect(() => parseDeleteObject(new Uint8Array([0x08, 1, 2]))).toThrow(RangeError);
  });
});

describe("parseDie", () => {
  it("reads objectId and canTeleport ahead of the six respawn flags", () => {
    const w = new PacketWriter(0x00).writeInt32LE(268476032).writeInt32LE(1);

    for (let i = 0; i < 6; i++) w.writeInt32LE(0);

    expect(parseDie(w.toBytes())).toEqual({ objectId: 268476032, canTeleport: true });
  });

  it("reports canTeleport false for another creature's death", () => {
    const w = new PacketWriter(0x00).writeInt32LE(5).writeInt32LE(0);

    for (let i = 0; i < 6; i++) w.writeInt32LE(0);

    expect(parseDie(w.toBytes())).toEqual({ objectId: 5, canTeleport: false });
  });
});

describe("parseRevive", () => {
  it("reads the single objectId", () => {
    expect(parseRevive(new PacketWriter(0x01).writeInt32LE(7).toBytes())).toEqual({ objectId: 7 });
  });
});

describe("parseTeleportToLocation", () => {
  it("reads objectId, x, y, z, the fade flag and heading in order", () => {
    const body = new PacketWriter(0x22)
      .writeInt32LE(268476032)
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .writeInt32LE(0)
      .writeInt32LE(40000)
      .toBytes();

    expect(parseTeleportToLocation(body)).toEqual({
      objectId: 268476032,
      x: -84272,
      y: 245391,
      z: -3730,
      heading: 40000,
      isInstant: false,
    });
  });

  it("throws on a truncated body", () => {
    const body = new PacketWriter(0x22)
      .writeInt32LE(1)
      .writeInt32LE(2)
      .writeInt32LE(3)
      .writeInt32LE(4)
      .writeInt32LE(0)
      .writeInt32LE(6)
      .toBytes();

    expect(() => parseTeleportToLocation(body.subarray(0, body.length - 1))).toThrow(RangeError);
  });
});
