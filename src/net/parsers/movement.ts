/**
 * Parsers for the server's movement broadcasts. Same policy as the other parsers under
 * src/net/parsers/: read to the fields we use and stop.
 *
 * All three are broadcasts keyed by objectId (any actor moving in view range, not just us) -
 * callers must filter on the session's own objectId before acting on one.
 */

import PacketReader from "@client/net/binary/packet-reader";

export interface HeadedLocation {
  objectId: number;
  x: number;
  y: number;
  z: number;
  heading: number;
}

/**
 * StopMove (0x47) / ValidateLocation (0x79) - both
 * gameserver/network/serverpackets/{StopMove,ValidateLocation}.java writeImpl:
 * objectId, x, y, z, heading. Identical layout, kept as two functions so call sites stay
 * self-documenting about which packet they're reading.
 */
function parseHeadedLocation(body: Uint8Array): HeadedLocation {
  const r = new PacketReader(body);

  r.skip(1); // opcode

  const objectId = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const heading = r.readInt32LE();

  return { objectId, x, y, z, heading };
}

export const parseStopMove = parseHeadedLocation;
export const parseValidateLocation = parseHeadedLocation;

export interface ServerMoveToLocation {
  objectId: number;
  dstX: number;
  dstY: number;
  dstZ: number;
  x: number;
  y: number;
  z: number;
}

/**
 * MoveToLocation (0x2F) - gameserver/network/serverpackets/MoveToLocation.java writeImpl:
 * objectId, dstX, dstY, dstZ, x, y, z. DESTINATION BEFORE ORIGIN - the reverse field order of
 * the client's own 0x0F MoveToLocation. Do not copy the client builder's layout here.
 */
export function parseServerMoveToLocation(body: Uint8Array): ServerMoveToLocation {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x2F

  const objectId = r.readInt32LE();
  const dstX = r.readInt32LE();
  const dstY = r.readInt32LE();
  const dstZ = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  return { objectId, dstX, dstY, dstZ, x, y, z };
}

export default { parseStopMove, parseValidateLocation, parseServerMoveToLocation };
