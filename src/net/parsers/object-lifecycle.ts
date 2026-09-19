/**
 * The "object appeared / left / died / was moved" packets that carry nothing but an objectId and
 * a location. Sources, all under gameserver/network/serverpackets/:
 *   DeleteObject.java (0x08), Die.java (0x00), Revive.java (0x01), TeleportToLocation.java (0x22).
 *
 * Same policy as the other parsers under src/net/parsers/: read to the fields we use and stop.
 */

import PacketReader from "@client/net/binary/packet-reader";

export interface ObjectRef {
  objectId: number;
}

/** DeleteObject (0x08): objectId, then an unused C2-era int. */
export function parseDeleteObject(body: Uint8Array): ObjectRef {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x08

  return { objectId: r.readInt32LE() };
}

export interface DeathInfo extends ObjectRef {
  /** Whether the server is offering the respawn window - only ever true for our own character. */
  canTeleport: boolean;
}

/**
 * Die (0x00): objectId, canTeleport, then six flag ints for the respawn window's buttons
 * (hideout / castle / siege HQ / sweepable / fixed res / fortress). The protocol-152 tail in
 * Die.java is commented out, so H5 stops after the six flags.
 */
export function parseDie(body: Uint8Array): DeathInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x00

  const objectId = r.readInt32LE();
  const canTeleport = r.readInt32LE() !== 0;

  return { objectId, canTeleport };
}

/** Revive (0x01): objectId and nothing else. */
export function parseRevive(body: Uint8Array): ObjectRef {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x01

  return { objectId: r.readInt32LE() };
}

export interface TeleportInfo extends ObjectRef {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** The server hardcodes the fade/instant int to 0 today; kept so the field is not silently lost. */
  isInstant: boolean;
}

/** TeleportToLocation (0x22): objectId, x, y, z, fade(0)/instant(1), heading. */
export function parseTeleportToLocation(body: Uint8Array): TeleportInfo {
  const r = new PacketReader(body);

  r.skip(1); // opcode 0x22

  const objectId = r.readInt32LE();
  const x = r.readInt32LE();
  const y = r.readInt32LE();
  const z = r.readInt32LE();
  const isInstant = r.readInt32LE() !== 0;
  const heading = r.readInt32LE();

  return { objectId, x, y, z, heading, isInstant };
}

export default { parseDeleteObject, parseDie, parseRevive, parseTeleportToLocation };
