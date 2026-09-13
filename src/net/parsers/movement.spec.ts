import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import { parseServerMoveToLocation, parseStopMove, parseValidateLocation } from "@client/net/parsers/movement";

describe("parseStopMove / parseValidateLocation", () => {
  // Both are gameserver/network/serverpackets/{StopMove,ValidateLocation}.java writeImpl:
  // objectId, x, y, z, heading - identical layout.
  it("reads objectId, x, y, z, heading in order", () => {
    const body = new PacketWriter(0x47)
      .writeInt32LE(268476032)
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .writeInt32LE(40000)
      .toBytes();

    expect(parseStopMove(body)).toEqual({
      objectId: 268476032,
      x: -84272,
      y: 245391,
      z: -3730,
      heading: 40000,
    });
  });

  it("parseValidateLocation reads the same layout", () => {
    const body = new PacketWriter(0x79)
      .writeInt32LE(1)
      .writeInt32LE(2)
      .writeInt32LE(3)
      .writeInt32LE(4)
      .writeInt32LE(5)
      .toBytes();

    expect(parseValidateLocation(body)).toEqual({ objectId: 1, x: 2, y: 3, z: 4, heading: 5 });
  });
});

describe("parseServerMoveToLocation", () => {
  it("reads DESTINATION before ORIGIN - the reverse of the client's own 0x0F packet", () => {
    // gameserver/network/serverpackets/MoveToLocation.java writeImpl:
    // objectId, dstX, dstY, dstZ, x, y, z
    const body = new PacketWriter(0x2f)
      .writeInt32LE(268476032) // objectId
      .writeInt32LE(100) // dstX
      .writeInt32LE(200) // dstY
      .writeInt32LE(300) // dstZ
      .writeInt32LE(10) // x (origin/current)
      .writeInt32LE(20) // y
      .writeInt32LE(30) // z
      .toBytes();

    expect(parseServerMoveToLocation(body)).toEqual({
      objectId: 268476032,
      dstX: 100,
      dstY: 200,
      dstZ: 300,
      x: 10,
      y: 20,
      z: 30,
    });
  });
});
