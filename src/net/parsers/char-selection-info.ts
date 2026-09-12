/**
 * CharSelectionInfo (0x09) - the character list, and the earliest place the server tells us
 * where the character stands.
 *
 * Field order is taken from gameserver/network/serverpackets/CharSelectionInfo.java, NOT from
 * server-protocol.md, which lists only `C 0x09 + D charCount` and omits the two header fields
 * that follow. Record length varies (two UTF-16 strings), so the walk has to read every field
 * rather than jump by a fixed stride - hence the long run of named skips below. Getting one of
 * them wrong shifts every subsequent record, which is what the spec exists to catch.
 */

import PacketReader from "@client/net/binary/packet-reader";

export interface CharacterInfo {
  slot: number;
  name: string;
  objectId: number;
  classId: number;
  level: number;
  x: number;
  y: number;
  z: number;
  active: boolean;
}

export interface CharSelectionInfo {
  chars: CharacterInfo[];
  maxChars: number;
}

/** 26 paperdoll slots, see PAPERDOLL_ORDER in gameserver/network/serverpackets/ServerPacket.java. */
const PAPERDOLL_SLOTS = 26;

export function parseCharSelectionInfo(body: Uint8Array): CharSelectionInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x09

  const count = r.readInt32LE();
  const maxChars = r.readInt32LE();

  r.skip(1); // unknown, always 0

  const chars: CharacterInfo[] = [];

  for (let slot = 0; slot < count; slot++) {
    const name = r.readStringUTF16();
    const objectId = r.readInt32LE();

    r.readStringUTF16(); // account login name
    r.skipInt32(1); // sessionId
    r.skipInt32(1); // clanId
    r.skipInt32(1); // builder level, always 0
    r.skipInt32(1); // sex
    r.skipInt32(1); // race
    r.skipInt32(1); // base class id
    r.skipInt32(1); // GameServerName, always 1

    const x = r.readInt32LE();
    const y = r.readInt32LE();
    const z = r.readInt32LE();

    r.skipDouble(2); // current HP, current MP
    r.skipInt32(1); // sp
    r.skip(8); // exp (long)
    r.skipDouble(1); // exp percent - a HighFive-only field

    const level = r.readInt32LE();

    r.skipInt32(1); // karma
    r.skipInt32(1); // pk kills
    r.skipInt32(1); // pvp kills
    r.skipInt32(7); // seven unknown zeros
    r.skipInt32(PAPERDOLL_SLOTS); // paperdoll item ids
    r.skipInt32(1); // hair style
    r.skipInt32(1); // hair colour
    r.skipInt32(1); // face
    r.skipDouble(2); // max HP, max MP
    r.skipInt32(1); // delete timer (seconds, or -1 when banned)

    const classId = r.readInt32LE();
    const active = r.readInt32LE() !== 0;

    r.skip(1); // enchant effect, capped at 127
    r.skipInt32(1); // augmentation id
    r.skipInt32(1); // transform id, always 0
    r.skipInt32(4); // pet npc id, level, food, food level
    r.skipDouble(2); // pet HP, pet MP
    r.skipInt32(1); // vitality points

    chars.push({ slot, name, objectId, classId, level, x, y, z, active });
  }

  return { chars, maxChars };
}

export default parseCharSelectionInfo;
