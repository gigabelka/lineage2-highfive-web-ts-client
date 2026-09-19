import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import {
  WAIT_TYPE,
  parseChangeMoveType,
  parseChangeWaitType,
  parseMoveToPawn,
  parseServerMoveToLocation,
  parseStopMove,
  parseValidateLocation,
} from "@client/net/parsers/movement";

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

describe("parseMoveToPawn", () => {
  // gameserver/network/serverpackets/MoveToPawn.java writeImpl: objectId, targetId, distance,
  // mover x/y/z, target x/y/z. This is what an aggro chase arrives as, not 0x2F.
  it("reads the mover and target blocks in order", () => {
    const body = new PacketWriter(0x72)
      .writeInt32LE(268476032)
      .writeInt32LE(268476040)
      .writeInt32LE(40)
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .writeInt32LE(-84300)
      .writeInt32LE(245420)
      .writeInt32LE(-3728)
      .toBytes();

    expect(parseMoveToPawn(body)).toEqual({
      objectId: 268476032,
      targetId: 268476040,
      distance: 40,
      x: -84272,
      y: 245391,
      z: -3730,
      targetX: -84300,
      targetY: 245420,
      targetZ: -3728,
    });
  });

  it("throws on a truncated body", () => {
    expect(() => parseMoveToPawn(new Uint8Array([0x72, 1, 2, 3]))).toThrow(RangeError);
  });
});

describe("parseChangeMoveType / parseChangeWaitType", () => {
  it("reads the walk/run flag", () => {
    const run = new PacketWriter(0x28).writeInt32LE(5).writeInt32LE(1).writeInt32LE(0).toBytes();
    const walk = new PacketWriter(0x28).writeInt32LE(5).writeInt32LE(0).writeInt32LE(0).toBytes();

    expect(parseChangeMoveType(run)).toEqual({ objectId: 5, isRunning: true });
    expect(parseChangeMoveType(walk)).toEqual({ objectId: 5, isRunning: false });
  });

  it("reads the wait type and the position it applies at", () => {
    const body = new PacketWriter(0x29)
      .writeInt32LE(5)
      .writeInt32LE(WAIT_TYPE.SITTING)
      .writeInt32LE(1)
      .writeInt32LE(2)
      .writeInt32LE(3)
      .toBytes();

    expect(parseChangeWaitType(body)).toEqual({
      objectId: 5,
      waitType: WAIT_TYPE.SITTING,
      x: 1,
      y: 2,
      z: 3,
    });
  });
});
