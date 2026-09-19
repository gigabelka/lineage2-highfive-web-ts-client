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

export interface ServerMoveToPawn {
  objectId: number;
  targetId: number;
  /** How close the mover intends to get - an attack range or a follow offset. */
  distance: number;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/**
 * MoveToPawn (0x72) - gameserver/network/serverpackets/MoveToPawn.java writeImpl:
 * objectId, targetId, distance, mover x/y/z, target x/y/z. Creature.broadcastMoveToLocation
 * picks this over 0x2F for an NPC whose intention is ATTACK or FOLLOW and which is not walking
 * a geodata path, so most aggro chases arrive here rather than as MoveToLocation.
 */
export function parseMoveToPawn(body: Uint8Array): ServerMoveToPawn {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x72

  const objectId = r.readInt32LE();
  const targetId = r.readInt32LE();
  const distance = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const targetX = r.readInt32LE();
  const targetY = r.readInt32LE();
  const targetZ = r.readInt32LE();

  return { objectId, targetId, distance, x, y, z, targetX, targetY, targetZ };
}

export interface MoveTypeChange {
  objectId: number;
  isRunning: boolean;
}

/** ChangeMoveType (0x28): objectId, 0 = walk / 1 = run, then an unused C2-era int. */
export function parseChangeMoveType(body: Uint8Array): MoveTypeChange {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x28

  const objectId = r.readInt32LE();
  const isRunning = r.readInt32LE() !== 0;

  return { objectId, isRunning };
}

/** ChangeWaitType's `_moveType`, from gameserver/network/serverpackets/ChangeWaitType.java. */
export const WAIT_TYPE = {
  SITTING: 0,
  STANDING: 1,
  START_FAKEDEATH: 2,
  STOP_FAKEDEATH: 3,
} as const;

export interface WaitTypeChange {
  objectId: number;
  waitType: number;
  x: number;
  y: number;
  z: number;
}

/** ChangeWaitType (0x29): objectId, moveType, x, y, z. */
export function parseChangeWaitType(body: Uint8Array): WaitTypeChange {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x29

  const objectId = r.readInt32LE();
  const waitType = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();

  return { objectId, waitType, x, y, z };
}

export default {
  parseStopMove,
  parseValidateLocation,
  parseServerMoveToLocation,
  parseMoveToPawn,
  parseChangeMoveType,
  parseChangeWaitType,
};
