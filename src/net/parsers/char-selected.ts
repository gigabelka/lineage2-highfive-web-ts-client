/**
 * CharSelected (0x0B) - the confirmation for CharacterSelected, and a second coordinate hint
 * before EnterWorld. Field order from gameserver/network/serverpackets/CharSelected.java.
 *
 * Same policy as user-info.ts: read to the coordinates and stop.
 */

import PacketReader from "@client/net/binary/packet-reader";

export interface CharSelectedBrief {
  name: string;
  objectId: number;
  classId: number;
  x: number;
  y: number;
  z: number;
}

export function parseCharSelected(body: Uint8Array): CharSelectedBrief {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x0B

  const name = r.readStringUTF16();
  const objectId = r.readInt32LE();

  r.readStringUTF16(); // title
  r.skipInt32(1); // sessionId
  r.skipInt32(1); // clanId
  r.skipInt32(1); // unknown, always 0
  r.skipInt32(1); // isFemale
  r.skipInt32(1); // race

  const classId = r.readInt32LE();

  r.skipInt32(1); // active, always 1

  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  return { name, objectId, classId, x, y, z };
}

export default parseCharSelected;
