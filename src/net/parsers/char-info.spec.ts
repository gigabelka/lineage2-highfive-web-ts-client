import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import {
  CHAR_INFO_PAPERDOLL,
  CHAR_INFO_PAPERDOLL_SLOTS,
  parseCharInfo,
} from "@client/net/parsers/char-info";

/*
 * Written straight from CharInfo.writeImpl, independently of the parser, so the two must agree
 * on the layout rather than on a shared helper. CharInfo is the one packet here the parser has
 * to walk in full - `heading` sits past a variable-length cubic list near the end - so the
 * fixture has to be complete up to that point, and the tail after it is written too.
 */
function charInfoBody(
  opts: { name?: string; title?: string; cubics?: number[]; chest?: number } = {},
): Uint8Array {
  const { name = "Tester", title = "", cubics = [], chest = 23 } = opts;
  const w = new PacketWriter(0x31)
    .writeInt32LE(-84272) // x
    .writeInt32LE(245391) // y
    .writeInt32LE(-3730) // z
    .writeInt32LE(0) // vehicleId
    .writeInt32LE(268476040) // objectId
    .writeStringNullUTF16(name)
    .writeInt32LE(1) // race - elf
    .writeInt32LE(1) // isFemale
    .writeInt32LE(25); // baseClass

  // Paperdoll pass 1: item display ids, CharInfo's own 21-slot order.
  for (let i = 0; i < CHAR_INFO_PAPERDOLL_SLOTS; i++)
    w.writeInt32LE(i === CHAR_INFO_PAPERDOLL.CHEST ? chest : 0);

  // Paperdoll pass 2: augmentation ids, same order. (UserInfo has a third pass - CharInfo does not.)
  for (let i = 0; i < CHAR_INFO_PAPERDOLL_SLOTS; i++) w.writeInt32LE(0);

  w.writeInt32LE(0) // talismanSlots
    .writeInt32LE(0) // canEquipCloak
    .writeInt32LE(0) // pvpFlag
    .writeInt32LE(0) // karma
    .writeInt32LE(333) // mAtkSpd
    .writeInt32LE(310) // pAtkSpd
    .writeInt32LE(0) // unused
    .writeInt32LE(126) // runSpd
    .writeInt32LE(83) // walkSpd
    .writeInt32LE(50) // swimRunSpd
    .writeInt32LE(50) // swimWalkSpd
    .writeInt32LE(126) // flyRunSpd
    .writeInt32LE(83) // flyWalkSpd
    .writeInt32LE(126) // flyRunSpd again
    .writeInt32LE(83) // flyWalkSpd again
    .writeDoubleLE(1.0) // moveMultiplier
    .writeDoubleLE(1.0) // attackSpeedMultiplier
    .writeDoubleLE(7.5) // collisionRadius
    .writeDoubleLE(24.0) // collisionHeight
    .writeInt32LE(2) // hairStyle
    .writeInt32LE(3) // hairColor
    .writeInt32LE(1) // face
    .writeStringNullUTF16(title)
    .writeInt32LE(0) // clanId
    .writeInt32LE(0) // clanCrestId
    .writeInt32LE(0) // allyId
    .writeInt32LE(0) // allyCrestId
    .writeUInt8(1) // !isSitting -> standing
    .writeUInt8(1) // isRunning
    .writeUInt8(0) // isInCombat
    .writeUInt8(0) // isAlikeDead
    .writeUInt8(0) // isInvisible
    .writeUInt8(2) // mountType - wyvern
    .writeUInt8(0) // privateStoreType
    .writeUInt16LE(cubics.length);

  for (const cubic of cubics) w.writeUInt16LE(cubic);

  w.writeUInt8(0) // isInPartyMatchRoom
    .writeInt32LE(0) // abnormalVisualEffects
    .writeUInt8(0) // water / flying-mounted flag
    .writeUInt16LE(255) // recomHave
    .writeInt32LE(1000000) // mountNpcId + 1000000
    .writeInt32LE(93) // playerClassId
    .writeInt32LE(0) // unused
    .writeUInt8(0) // enchantEffect
    .writeUInt8(0) // teamId
    .writeInt32LE(0) // clanCrestLargeId
    .writeUInt8(0) // isNoble
    .writeUInt8(0) // isHero
    .writeUInt8(0) // isFishing
    .writeInt32LE(0) // fishX
    .writeInt32LE(0) // fishY
    .writeInt32LE(0) // fishZ
    .writeInt32LE(0) // nameColor
    .writeInt32LE(40000) // heading
    .writeInt32LE(0) // pledgeClass
    .writeInt32LE(0) // pledgeType
    .writeInt32LE(0) // titleColor
    .writeInt32LE(0) // cursedWeaponLevel
    .writeInt32LE(0) // clan reputation
    .writeInt32LE(0) // transformationDisplayId
    .writeInt32LE(0) // agathionId
    .writeInt32LE(1) // T2
    .writeInt32LE(0); // abnormalVisualEffectSpecial

  return w.toBytes();
}

describe("parseCharInfo", () => {
  it("walks the whole packet and lands on heading", () => {
    const info = parseCharInfo(charInfoBody());

    expect(info).toMatchObject({
      objectId: 268476040,
      x: -84272,
      y: 245391,
      z: -3730,
      heading: 40000,
      name: "Tester",
      title: "",
      race: 1,
      isFemale: true,
      baseClass: 25,
      classId: 93,
      hairStyle: 2,
      hairColor: 3,
      face: 1,
      runSpeed: 126,
      walkSpeed: 83,
      collisionRadius: 7.5,
      collisionHeight: 24.0,
      isSitting: false,
      isRunning: true,
      isInCombat: false,
      isAlikeDead: false,
      mountType: 2,
    });
  });

  it("indexes the paperdoll by CharInfo's own 21-slot order", () => {
    const info = parseCharInfo(charInfoBody({ chest: 2382 }));

    expect(info.paperdollDisplayIds).toHaveLength(CHAR_INFO_PAPERDOLL_SLOTS);
    expect(info.paperdollDisplayIds[CHAR_INFO_PAPERDOLL.CHEST]).toBe(2382);
    expect(info.paperdollDisplayIds[CHAR_INFO_PAPERDOLL.LEGS]).toBe(0);
  });

  it("keeps its place past a non-empty cubic list", () => {
    // The cubic count is the one variable-stride field before heading - if it is mis-skipped,
    // heading and everything after it shift.
    const info = parseCharInfo(charInfoBody({ cubics: [30, 31, 32] }));

    expect(info.heading).toBe(40000);
    expect(info.classId).toBe(93);
  });

  it("reads a non-ASCII name and title", () => {
    const info = parseCharInfo(charInfoBody({ name: "Второй", title: "Тест" }));

    expect(info.name).toBe("Второй");
    expect(info.title).toBe("Тест");
  });

  it("throws rather than reporting a shifted heading on a truncated body", () => {
    const body = charInfoBody();

    expect(() => parseCharInfo(new Uint8Array([0x31, 1, 2]))).toThrow(RangeError);
    // Cut one byte short of heading's last byte.
    expect(() => parseCharInfo(body.subarray(0, body.length - 40))).toThrow(RangeError);
  });
});
