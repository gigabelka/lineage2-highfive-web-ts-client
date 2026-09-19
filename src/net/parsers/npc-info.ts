/**
 * Parsers for the two packets that make a non-player creature visible.
 *
 * gameserver/network/serverpackets/AbstractNpcInfo.java (0x0C) and
 * gameserver/network/serverpackets/ServerObjectInfo.java (0x92). See CORRECTIONS 5 and 6 in
 * src/net/opcodes.ts: 0x0C is shared by NpcInfo/SummonInfo/TrapInfo and we only read the prefix
 * the three agree on, and an immobile NPC (getRunSpeed() == 0) never comes through 0x0C at all.
 *
 * Same policy as the other parsers under src/net/parsers/: read to the fields we use and stop.
 */

import PacketReader from "@client/net/binary/packet-reader";

/**
 * The subset of a creature-info packet the renderer needs. `npcTypeId` is still the raw wire
 * value (`displayId + 1000000`); Npcgrp.dat is keyed by the raw id, so the consumer subtracts
 * NPC_TYPE_ID_OFFSET before resolving a mesh.
 */
export interface NpcInfoBrief {
  objectId: number;
  npcTypeId: number;
  isAttackable: boolean;
  x: number;
  y: number;
  z: number;
  heading: number;
  runSpeed: number;
  walkSpeed: number;
  collisionRadius: number;
  collisionHeight: number;
  isRunning: boolean;
  isInCombat: boolean;
  isAlikeDead: boolean;
  /** Empty unless the template is `isUsingServerSideName()` - otherwise the client names it from npcname-e.dat. */
  name: string;
  title: string;
}

/** AbstractNpcInfo/ServerObjectInfo both send `displayId + 1000000` as the npc type id. */
export const NPC_TYPE_ID_OFFSET = 1000000;

/**
 * NpcInfo / SummonInfo / TrapInfo (0x0C). Returns null when the body carries nothing but the
 * opcode: `NpcInfo.writeImpl` returns early on `_npc.isDecayed()`, having written no fields.
 */
export function parseNpcInfo(body: Uint8Array): NpcInfoBrief | null {
  if (body.length <= 1) return null;

  const r = new PacketReader(body);

  r.skip(1); // opcode 0x0C

  const objectId = r.readInt32LE();
  const npcTypeId = r.readInt32LE();
  const isAttackable = r.readInt32LE() !== 0;
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const heading = r.readInt32LE();

  r.skipInt32(1); // always 0
  r.skipInt32(2); // mAtkSpd, pAtkSpd

  const runSpeed = r.readInt32LE();
  const walkSpeed = r.readInt32LE();

  r.skipInt32(2); // swimRunSpd, swimWalkSpd
  r.skipInt32(4); // flyRunSpd, flyWalkSpd, then the same pair a second time
  r.skipDouble(2); // moveMultiplier, attackSpeedMultiplier

  const collisionRadius = r.readDoubleLE();
  const collisionHeight = r.readDoubleLE();

  r.skipInt32(3); // rhand, chest, lhand item display ids
  r.skip(1); // "name above char", hardcoded 1

  const isRunning = r.readUInt8() !== 0;
  const isInCombat = r.readUInt8() !== 0;
  const isAlikeDead = r.readUInt8() !== 0;

  r.skip(1); // 0 = normal, 2 = summoned (plays the summon animation)
  r.skipInt32(1); // NPCString id for the name, -1 = use the string that follows

  const name = r.readStringUTF16();

  r.skipInt32(1); // NPCString id for the title

  const title = r.readStringUTF16();

  /* Everything past the title (title colour, pvp flag, karma, abnormal effects, clan/ally
     crests, the repeated collision pair, enchant/fly/colour effects, ...) is where NpcInfo,
     SummonInfo and TrapInfo start to disagree, and none of it is used yet. */

  return {
    objectId,
    npcTypeId,
    isAttackable,
    x,
    y,
    z,
    heading,
    runSpeed,
    walkSpeed,
    collisionRadius,
    collisionHeight,
    isRunning,
    isInCombat,
    isAlikeDead,
    name,
    title,
  };
}

/**
 * ServerObjectInfo (0x92) - the packet an immobile NPC is sent with. Much shorter than 0x0C and
 * in a different order (the name comes third, there is no speed/status block), so it cannot
 * share the reader above. Fields it does not carry are reported as the standing-still defaults.
 */
export function parseServerObjectInfo(body: Uint8Array): NpcInfoBrief {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x92

  const objectId = r.readInt32LE();
  const npcTypeId = r.readInt32LE();
  const name = r.readStringUTF16();
  const isAttackable = r.readInt32LE() !== 0;
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const heading = r.readInt32LE();

  r.skipDouble(2); // movement multiplier and attack speed multiplier, both hardcoded 1.0

  const collisionRadius = r.readDoubleLE();
  const collisionHeight = r.readDoubleLE();

  /* Remaining: currentHp, maxHp, object type (1), special effects - not used yet. */

  return {
    objectId,
    npcTypeId,
    isAttackable,
    x,
    y,
    z,
    heading,
    runSpeed: 0, // this packet is only ever used for run-speed-0 NPCs
    walkSpeed: 0,
    collisionRadius,
    collisionHeight,
    isRunning: false,
    isInCombat: false,
    isAlikeDead: false,
    name,
    title: "",
  };
}

export default { parseNpcInfo, parseServerObjectInfo };
