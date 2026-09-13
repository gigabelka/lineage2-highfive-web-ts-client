/**
 * Pure builders for the outgoing movement packets - kept out of game-client.ts so they can be
 * unit tested without a socket (today's outgoing packets are all assembled inline in
 * game-client.ts, which can't be exercised without a fake connection).
 *
 * Field order and byte layout are ported from the server source
 * (gameserver/network/clientpackets/), see docs/networking.md "Outgoing movement" and the
 * comment block at the top of opcodes.ts.
 *
 * Callers must pass already-rounded integers: three.js positions are floats, the wire format is
 * int32.
 */

import PacketWriter from "@client/net/binary/packet-writer";
import { OPCODES } from "@client/net/opcodes";

export interface Vec3I {
  x: number;
  y: number;
  z: number;
}

/**
 * MoveToLocation (0x0F) - clientpackets/MoveToLocation.java readImpl:
 * targetX, targetY, targetZ, originX, originY, originZ, movementMode.
 * movementMode: 1 = mouse/click-to-move (our case), 0 = cursor-key movement (requires
 * PlayerConfig.ENABLE_KEYBOARD_MOVEMENT on the server, silently ignored otherwise).
 */
export function buildMoveToLocation(target: Vec3I, origin: Vec3I, movementMode: 0 | 1 = 1): Uint8Array {
  return new PacketWriter(OPCODES.game.out.MoveToLocation)
    .writeInt32LE(Math.round(target.x))
    .writeInt32LE(Math.round(target.y))
    .writeInt32LE(Math.round(target.z))
    .writeInt32LE(Math.round(origin.x))
    .writeInt32LE(Math.round(origin.y))
    .writeInt32LE(Math.round(origin.z))
    .writeInt32LE(movementMode)
    .toBytes();
}

/**
 * ValidatePosition (0x59) - clientpackets/ValidatePosition.java readImpl:
 * x, y, z, heading, vehicleId. heading is 0..65535 (PawnMovementComponent.rotationYaw is
 * already in this unit). vehicleId is read and discarded server-side outside boats.
 */
export function buildValidatePosition(position: Vec3I, heading: number, vehicleId = 0): Uint8Array {
  return new PacketWriter(OPCODES.game.out.ValidatePosition)
    .writeInt32LE(Math.round(position.x))
    .writeInt32LE(Math.round(position.y))
    .writeInt32LE(Math.round(position.z))
    .writeInt32LE(heading & 0xffff)
    .writeInt32LE(vehicleId)
    .toBytes();
}

export default { buildMoveToLocation, buildValidatePosition };
