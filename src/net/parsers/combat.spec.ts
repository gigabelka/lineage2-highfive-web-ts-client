import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import {
  HIT_FLAG,
  STATUS_ATTRIBUTE,
  parseAttack,
  parseAutoAttack,
  parseMagicSkillUse,
  parseSocialAction,
  parseStatusUpdate,
} from "@client/net/parsers/combat";

describe("parseAttack", () => {
  it("reads the inline first hit before the attacker position", () => {
    // Attack.writeImpl writes hit 0 inline, THEN the attacker position, THEN size-1 and the rest.
    const body = new PacketWriter(0x33)
      .writeInt32LE(268476032) // attackerId
      .writeInt32LE(268476033) // hit 0 targetId
      .writeInt32LE(142) // hit 0 damage
      .writeUInt8(HIT_FLAG.CRITICAL) // hit 0 flags
      .writeInt32LE(-84272) // attacker x
      .writeInt32LE(245391) // attacker y
      .writeInt32LE(-3730) // attacker z
      .writeUInt16LE(0) // hits.size() - 1
      .writeInt32LE(-84300) // target x
      .writeInt32LE(245400) // target y
      .writeInt32LE(-3730) // target z
      .toBytes();

    expect(parseAttack(body)).toEqual({
      attackerId: 268476032,
      hits: [{ targetId: 268476033, damage: 142, flags: HIT_FLAG.CRITICAL }],
      x: -84272,
      y: 245391,
      z: -3730,
      targetX: -84300,
      targetY: 245400,
      targetZ: -3730,
    });
  });

  it("reads the extra hits of a dual-wield attack", () => {
    const body = new PacketWriter(0x33)
      .writeInt32LE(1)
      .writeInt32LE(2) // hit 0
      .writeInt32LE(10)
      .writeUInt8(0)
      .writeInt32LE(0)
      .writeInt32LE(0)
      .writeInt32LE(0)
      .writeUInt16LE(1) // one more hit follows
      .writeInt32LE(3) // hit 1
      .writeInt32LE(0)
      .writeUInt8(HIT_FLAG.MISS)
      .writeInt32LE(0)
      .writeInt32LE(0)
      .writeInt32LE(0)
      .toBytes();

    const attack = parseAttack(body);

    expect(attack.hits).toHaveLength(2);
    expect(attack.hits[1]).toEqual({ targetId: 3, damage: 0, flags: HIT_FLAG.MISS });
  });

  it("throws on a truncated body", () => {
    expect(() => parseAttack(new Uint8Array([0x33, 1, 2, 3]))).toThrow(RangeError);
  });
});

describe("parseStatusUpdate", () => {
  it("reads the attribute pairs into a map", () => {
    const body = new PacketWriter(0x18)
      .writeInt32LE(268476032)
      .writeInt32LE(2)
      .writeInt32LE(STATUS_ATTRIBUTE.CUR_HP)
      .writeInt32LE(400)
      .writeInt32LE(STATUS_ATTRIBUTE.MAX_HP)
      .writeInt32LE(900)
      .toBytes();

    const update = parseStatusUpdate(body);

    expect(update.objectId).toBe(268476032);
    expect(update.attributes.get(STATUS_ATTRIBUTE.CUR_HP)).toBe(400);
    expect(update.attributes.get(STATUS_ATTRIBUTE.MAX_HP)).toBe(900);
  });

  it("throws when the declared count outruns the body", () => {
    const body = new PacketWriter(0x18).writeInt32LE(1).writeInt32LE(3).writeInt32LE(9).toBytes();

    expect(() => parseStatusUpdate(body)).toThrow(RangeError);
  });
});

describe("parseSocialAction", () => {
  it("reads objectId and actionId", () => {
    const body = new PacketWriter(0x27).writeInt32LE(5).writeInt32LE(2122).toBytes();

    expect(parseSocialAction(body)).toEqual({ objectId: 5, actionId: 2122 });
  });
});

describe("parseMagicSkillUse", () => {
  it("reads the head up to the caster position", () => {
    const body = new PacketWriter(0x48)
      .writeInt32LE(1) // casterId
      .writeInt32LE(2) // targetId
      .writeInt32LE(1177) // skillId
      .writeInt32LE(3) // skillLevel
      .writeInt32LE(1500) // hitTime
      .writeInt32LE(5000) // reuseDelay
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .writeUInt16LE(0) // ground-target marker - past what we read
      .toBytes();

    expect(parseMagicSkillUse(body)).toEqual({
      casterId: 1,
      targetId: 2,
      skillId: 1177,
      skillLevel: 3,
      hitTime: 1500,
      reuseDelay: 5000,
      x: -84272,
      y: 245391,
      z: -3730,
    });
  });
});

describe("parseAutoAttack", () => {
  it("reads the single objectId of both 0x25 and 0x26", () => {
    expect(parseAutoAttack(new PacketWriter(0x25).writeInt32LE(9).toBytes())).toEqual({
      objectId: 9,
    });
    expect(parseAutoAttack(new PacketWriter(0x26).writeInt32LE(9).toBytes())).toEqual({
      objectId: 9,
    });
  });
});
