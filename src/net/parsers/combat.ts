/**
 * Combat and status broadcasts. Sources, all under gameserver/network/serverpackets/:
 *   Attack.java (0x33), StatusUpdate.java (0x18), SocialAction.java (0x27),
 *   MagicSkillUse.java (0x48), AutoAttackStart.java (0x25), AutoAttackStop.java (0x26).
 *
 * Same policy as the other parsers under src/net/parsers/: read to the fields we use and stop.
 *
 * AbnormalStatusUpdate (0x85) deliberately has NO parser here. It carries no objectId (it only
 * ever describes the receiving player), and its count is `_effects.size()` while the loop skips
 * entries that are not `isInUse()` - so the declared count can exceed what was actually written
 * and a full read would desync. Nothing in the world view needs it yet.
 */

import PacketReader from "@client/net/binary/packet-reader";

/** Hit flag bits, from gameserver/model/Hit.java. The low bits also carry the soulshot grade. */
export const HIT_FLAG = {
  USE_SOULSHOT: 0x10,
  CRITICAL: 0x20,
  SHIELD: 0x40,
  MISS: 0x80,
} as const;

export interface AttackHit {
  targetId: number;
  damage: number;
  flags: number;
}

export interface AttackInfo {
  attackerId: number;
  hits: AttackHit[];
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

function readHit(r: PacketReader): AttackHit {
  return { targetId: r.readInt32LE(), damage: r.readInt32LE(), flags: r.readUInt8() };
}

/**
 * Attack (0x33). The layout is lopsided on purpose: the FIRST hit is written inline right after
 * the attacker id, then the attacker's position, then `hits.size() - 1` as a uint16 followed by
 * the REMAINING hits, and only then the target position. A dual-wield/multi-target attack is the
 * only case where that trailing count is non-zero.
 */
export function parseAttack(body: Uint8Array): AttackInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x33

  const attackerId = r.readInt32LE();
  const hits = [readHit(r)];
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const extraHits = r.readUInt16LE();

  for (let i = 0; i < extraHits; i++) hits.push(readHit(r));

  const targetX = r.readInt32LE();
  const targetY = r.readInt32LE();
  const targetZ = r.readInt32LE();

  return { attackerId, hits, x, y, z, targetX, targetY, targetZ };
}

/** StatusUpdate attribute ids, from gameserver/network/serverpackets/StatusUpdate.java. */
export const STATUS_ATTRIBUTE = {
  LEVEL: 0x01,
  CUR_HP: 0x09,
  MAX_HP: 0x0a,
  CUR_MP: 0x0b,
  MAX_MP: 0x0c,
  PVP_FLAG: 0x1a,
  KARMA: 0x1b,
  CUR_CP: 0x21,
  MAX_CP: 0x22,
} as const;

export interface StatusUpdateInfo {
  objectId: number;
  /** Attribute id to value, in the order the server wrote them. */
  attributes: Map<number, number>;
}

/** StatusUpdate (0x18): objectId, count, then count pairs of (attributeId, value). */
export function parseStatusUpdate(body: Uint8Array): StatusUpdateInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x18

  const objectId = r.readInt32LE();
  const count = r.readInt32LE();
  const attributes = new Map<number, number>();

  for (let i = 0; i < count; i++) {
    const id = r.readInt32LE();
    attributes.set(id, r.readInt32LE());
  }

  return { objectId, attributes };
}

export interface SocialActionInfo {
  objectId: number;
  actionId: number;
}

/** SocialAction (0x27): objectId, actionId. `LEVEL_UP` is 2122, the gestures are small ids. */
export function parseSocialAction(body: Uint8Array): SocialActionInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x27

  const objectId = r.readInt32LE();
  const actionId = r.readInt32LE();

  return { objectId, actionId };
}

export interface SkillUseInfo {
  casterId: number;
  targetId: number;
  skillId: number;
  skillLevel: number;
  /** Cast time in ms - how long the caster should hold the casting pose. */
  hitTime: number;
  reuseDelay: number;
  x: number;
  y: number;
  z: number;
}

/**
 * MagicSkillUse (0x48): casterId, targetId, skillId, skillLevel, hitTime, reuseDelay, caster
 * x/y/z. What follows (a ground-target marker, an optional ground location and the target's
 * position) is only needed for ground-targeted casts and is not read.
 */
export function parseMagicSkillUse(body: Uint8Array): SkillUseInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x48

  const casterId = r.readInt32LE();
  const targetId = r.readInt32LE();
  const skillId = r.readInt32LE();
  const skillLevel = r.readInt32LE();
  const hitTime = r.readInt32LE();
  const reuseDelay = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  return { casterId, targetId, skillId, skillLevel, hitTime, reuseDelay, x, y, z };
}

/**
 * AutoAttackStart (0x25) / AutoAttackStop (0x26). Both carry a single object id - the actor
 * entering or leaving the combat stance, despite the server field being named `_targetObjId`.
 */
export function parseAutoAttack(body: Uint8Array): { objectId: number } {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x25 or 0x26

  return { objectId: r.readInt32LE() };
}

export default {
  parseAttack,
  parseStatusUpdate,
  parseSocialAction,
  parseMagicSkillUse,
  parseAutoAttack,
};
