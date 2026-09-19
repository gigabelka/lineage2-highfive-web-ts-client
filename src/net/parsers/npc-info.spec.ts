import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import {
  NPC_TYPE_ID_OFFSET,
  parseNpcInfo,
  parseServerObjectInfo,
} from "@client/net/parsers/npc-info";

/*
 * Fixtures are written straight from AbstractNpcInfo.NpcInfo.writeImpl / ServerObjectInfo.
 * writeImpl, independently of the parser, so the two have to agree on the layout rather than on
 * a shared helper.
 */
function npcInfoBody(name = "Gremlin", title = "Lv 1"): Uint8Array {
  const w = new PacketWriter(0x0c)
    .writeInt32LE(268476032) // objectId
    .writeInt32LE(1020001) // displayId + 1000000
    .writeInt32LE(1) // isAttackable
    .writeInt32LE(-84272) // x
    .writeInt32LE(245391) // y
    .writeInt32LE(-3730) // z
    .writeInt32LE(40000) // heading
    .writeInt32LE(0)
    .writeInt32LE(253) // mAtkSpd
    .writeInt32LE(281) // pAtkSpd
    .writeInt32LE(120) // runSpd
    .writeInt32LE(70) // walkSpd
    .writeInt32LE(50) // swimRunSpd
    .writeInt32LE(50) // swimWalkSpd
    .writeInt32LE(120) // flyRunSpd
    .writeInt32LE(70) // flyWalkSpd
    .writeInt32LE(120) // flyRunSpd again
    .writeInt32LE(70) // flyWalkSpd again
    .writeDoubleLE(1.0) // moveMultiplier
    .writeDoubleLE(1.0) // attackSpeedMultiplier
    .writeDoubleLE(9.5) // collisionRadius
    .writeDoubleLE(23.5) // collisionHeight
    .writeInt32LE(0) // rhand
    .writeInt32LE(0) // chest
    .writeInt32LE(0) // lhand
    .writeUInt8(1) // name above char
    .writeUInt8(1) // isRunning
    .writeUInt8(0) // isInCombat
    .writeUInt8(0) // isAlikeDead
    .writeUInt8(0) // summoned flag
    .writeInt32LE(-1) // NPCString id for the name
    .writeStringNullUTF16(name)
    .writeInt32LE(-1) // NPCString id for the title
    .writeStringNullUTF16(title)
    .writeInt32LE(0) // title colour - first field past what we read
    .writeInt32LE(0); // pvp flag

  return w.toBytes();
}

describe("parseNpcInfo", () => {
  it("reads the prefix NpcInfo/SummonInfo/TrapInfo agree on", () => {
    expect(parseNpcInfo(npcInfoBody())).toEqual({
      objectId: 268476032,
      npcTypeId: 1020001,
      isAttackable: true,
      x: -84272,
      y: 245391,
      z: -3730,
      heading: 40000,
      runSpeed: 120,
      walkSpeed: 70,
      collisionRadius: 9.5,
      collisionHeight: 23.5,
      isRunning: true,
      isInCombat: false,
      isAlikeDead: false,
      name: "Gremlin",
      title: "Lv 1",
    });
  });

  it("subtracting NPC_TYPE_ID_OFFSET gives the Npcgrp.dat tag", () => {
    expect(parseNpcInfo(npcInfoBody())!.npcTypeId - NPC_TYPE_ID_OFFSET).toBe(20001);
  });

  it("reads a server-side name the client would otherwise take from npcname-e.dat", () => {
    // Non-ASCII proves the UTF-16 walk lands on the terminator, not on a stray zero byte.
    expect(parseNpcInfo(npcInfoBody("Страж", ""))!.name).toBe("Страж");
  });

  it("returns null for the empty body a decayed npc is sent with", () => {
    // NpcInfo.writeImpl returns before writeId when _npc.isDecayed().
    expect(parseNpcInfo(new Uint8Array([0x0c]))).toBeNull();
    expect(parseNpcInfo(new Uint8Array([]))).toBeNull();
  });

  it("throws on a truncated body", () => {
    const body = npcInfoBody();

    expect(() => parseNpcInfo(body.subarray(0, 40))).toThrow(RangeError);
  });
});

describe("parseServerObjectInfo", () => {
  it("reads the immobile-npc layout, where the name comes third", () => {
    const body = new PacketWriter(0x92)
      .writeInt32LE(268476033) // objectId
      .writeInt32LE(1030001) // displayId + 1000000
      .writeStringNullUTF16("Blacksmith")
      .writeInt32LE(0) // isAttackable
      .writeInt32LE(15000) // x
      .writeInt32LE(142000) // y
      .writeInt32LE(-2700) // z
      .writeInt32LE(16384) // heading
      .writeDoubleLE(1.0) // movement multiplier
      .writeDoubleLE(1.0) // attack speed multiplier
      .writeDoubleLE(8.0) // collisionRadius
      .writeDoubleLE(24.0) // collisionHeight
      .writeInt32LE(0) // currentHp
      .writeInt32LE(0) // maxHp
      .writeInt32LE(1) // object type
      .writeInt32LE(0) // special effects
      .toBytes();

    expect(parseServerObjectInfo(body)).toEqual({
      objectId: 268476033,
      npcTypeId: 1030001,
      isAttackable: false,
      x: 15000,
      y: 142000,
      z: -2700,
      heading: 16384,
      runSpeed: 0,
      walkSpeed: 0,
      collisionRadius: 8.0,
      collisionHeight: 24.0,
      isRunning: false,
      isInCombat: false,
      isAlikeDead: false,
      name: "Blacksmith",
      title: "",
    });
  });

  it("throws on a truncated body", () => {
    expect(() => parseServerObjectInfo(new Uint8Array([0x92, 1, 2]))).toThrow(RangeError);
  });
});
