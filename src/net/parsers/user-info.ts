/**
 * UserInfo (0x32) - the authoritative "the character is in the world, here" packet.
 *
 * The whole packet is enormous and version-fragile, but the part we need sits right at the
 * front: gameserver/network/serverpackets/UserInfo.java writes x, y, z as the first three ints
 * after the opcode. (server-protocol.md says not to parse this packet at all; it also does not
 * mention that the coordinates are trivially reachable. There is no heading field here - that
 * rides CharInfo/MoveToLocation/ValidatePosition.)
 *
 * Deliberately stops after the visible name. Everything past it is stat/paperdoll payload we
 * have no use for, and reading it would only add ways to break on a server revision.
 */

import PacketReader from "@client/net/binary/packet-reader";

export interface UserInfoBrief {
  x: number;
  y: number;
  z: number;
  objectId: number;
  name: string;
}

export function parseUserInfo(body: Uint8Array): UserInfoBrief {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x32

  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  r.skipInt32(1); // vehicle object id, 0 when not on a boat

  const objectId = r.readInt32LE();
  const name = r.readStringUTF16();

  return { x, y, z, objectId, name };
}

export default parseUserInfo;
