/**
 * CharInfo (0x31) - gameserver/network/serverpackets/CharInfo.java writeImpl. This is how every
 * OTHER player becomes visible; our own character arrives as UserInfo (0x32) instead.
 *
 * CORRECTION 7 in src/net/opcodes.ts: CharInfo overrides getPaperdollOrder() with its own
 * 21-slot array and walks it TWICE (display id, augmentation id), where UserInfo uses the
 * default 26-slot array and walks it THREE times. The two layouts must not share code.
 *
 * Unlike the other parsers this one cannot stop early: `heading` sits near the very end of the
 * packet, past a variable-length cubic list, so the whole body up to it has to be walked. A
 * single wrong skip here silently rotates every player in view.
 */

import PacketReader from "@client/net/binary/packet-reader";

/** CharInfo's own paperdoll order, indices into `paperdollDisplayIds`. */
export const CHAR_INFO_PAPERDOLL = {
  UNDER: 0,
  HEAD: 1,
  RHAND: 2,
  LHAND: 3,
  GLOVES: 4,
  CHEST: 5,
  LEGS: 6,
  FEET: 7,
  CLOAK: 8,
  RHAND2: 9,
  HAIR: 10,
  HAIR2: 11,
  RBRACELET: 12,
  LBRACELET: 13,
  DECO1: 14,
  DECO2: 15,
  DECO3: 16,
  DECO4: 17,
  DECO5: 18,
  DECO6: 19,
  BELT: 20,
} as const;

/** How many slots CharInfo's getPaperdollOrder() returns. */
export const CHAR_INFO_PAPERDOLL_SLOTS = 21;

export interface CharInfoBrief {
  objectId: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  name: string;
  title: string;
  /** Race.ordinal(): 0 human, 1 elf, 2 dark elf, 3 orc, 4 dwarf, 5 kamael. */
  race: number;
  isFemale: boolean;
  /** The class the character started from - what decides the body mesh branch. */
  baseClass: number;
  /** The class actually being played right now. */
  classId: number;
  hairStyle: number;
  hairColor: number;
  face: number;
  /** Item display ids, indexed by CHAR_INFO_PAPERDOLL. */
  paperdollDisplayIds: number[];
  runSpeed: number;
  walkSpeed: number;
  collisionRadius: number;
  collisionHeight: number;
  isSitting: boolean;
  isRunning: boolean;
  isInCombat: boolean;
  isAlikeDead: boolean;
  /** 0 none, 1 strider, 2 wyvern, 3 great wolf. */
  mountType: number;
}

export function parseCharInfo(body: Uint8Array): CharInfoBrief {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x31

  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  r.skipInt32(1); // vehicleId

  const objectId = r.readInt32LE();
  const name = r.readStringUTF16();
  const race = r.readInt32LE();
  const isFemale = r.readInt32LE() !== 0;
  const baseClass = r.readInt32LE();
  const paperdollDisplayIds: number[] = [];

  for (let i = 0; i < CHAR_INFO_PAPERDOLL_SLOTS; i++) paperdollDisplayIds.push(r.readInt32LE());

  r.skipInt32(CHAR_INFO_PAPERDOLL_SLOTS); // the same order again, augmentation ids
  r.skipInt32(2); // talismanSlots, canEquipCloak
  r.skipInt32(2); // pvpFlag, karma
  r.skipInt32(3); // mAtkSpd, pAtkSpd, an unused 0

  const runSpeed = r.readInt32LE();
  const walkSpeed = r.readInt32LE();

  r.skipInt32(2); // swimRunSpd, swimWalkSpd
  r.skipInt32(4); // flyRunSpd, flyWalkSpd, then the same pair a second time
  r.skipDouble(2); // moveMultiplier, attackSpeedMultiplier

  const collisionRadius = r.readDoubleLE();
  const collisionHeight = r.readDoubleLE();
  const hairStyle = r.readInt32LE();
  const hairColor = r.readInt32LE();
  const face = r.readInt32LE();
  const title = r.readStringUTF16();

  r.skipInt32(4); // clanId, clanCrestId, allyId, allyCrestId (all zeroed for a cursed weapon)

  const isSitting = r.readUInt8() === 0; // written as `!isSitting`: standing = 1
  const isRunning = r.readUInt8() !== 0;
  const isInCombat = r.readUInt8() !== 0;
  const isAlikeDead = r.readUInt8() !== 0;

  r.skip(1); // invisible

  const mountType = r.readUInt8();

  r.skip(1); // privateStoreType

  const cubicCount = r.readUInt16LE();

  r.skip(cubicCount * 2); // one uint16 cubic id each

  r.skip(1); // isInPartyMatchRoom
  r.skipInt32(1); // abnormalVisualEffects
  r.skip(1); // 1 = in water, 2 = flying mounted
  r.skip(2); // recomHave (uint16)
  r.skipInt32(1); // mountNpcId + 1000000, unconditional here (UserInfo writes 0 when unmounted)

  const classId = r.readInt32LE();

  r.skipInt32(1); // unused 0
  r.skip(2); // enchantEffect, teamId
  r.skipInt32(1); // clanCrestLargeId
  r.skip(2); // isNoble, isHero
  r.skip(1); // isFishing
  r.skipInt32(3); // fishX, fishY, fishZ
  r.skipInt32(1); // nameColor

  const heading = r.readInt32LE();

  /* Remaining: pledgeClass, pledgeType, titleColor, cursedWeaponLevel, clan reputation, the T1
     transformation/agathion pair, a hardcoded 1 and abnormalVisualEffectSpecial - none used. */

  return {
    objectId,
    x,
    y,
    z,
    heading,
    name,
    title,
    race,
    isFemale,
    baseClass,
    classId,
    hairStyle,
    hairColor,
    face,
    paperdollDisplayIds,
    runSpeed,
    walkSpeed,
    collisionRadius,
    collisionHeight,
    isSitting,
    isRunning,
    isInCombat,
    isAlikeDead,
    mountType,
  };
}

export default parseCharInfo;
