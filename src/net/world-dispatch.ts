/**
 * The IN_GAME packet dispatcher, split out of `game-client.ts` so the state machine there stays
 * about the handshake and so this half can be unit-tested on its own.
 *
 * Pure: bytes in, a `WorldEvent` (or null for anything not handled) out. It does NOT filter on
 * our own objectId - `L2Session` does that, because it is the half that knows which objectId is
 * ours and what the player-only paths (`onCorrection` / `onPlace`) expect.
 */

import OPCODES from "@client/net/opcodes";
import type { WorldEvent } from "@client/net/world-events";
import { parseCharInfo } from "@client/net/parsers/char-info";
import { parseNpcInfo, parseServerObjectInfo } from "@client/net/parsers/npc-info";
import {
  parseAttack,
  parseAutoAttack,
  parseMagicSkillUse,
  parseSocialAction,
  parseStatusUpdate,
} from "@client/net/parsers/combat";
import {
  parseDeleteObject,
  parseDie,
  parseRevive,
  parseTeleportToLocation,
} from "@client/net/parsers/object-lifecycle";
import {
  parseChangeMoveType,
  parseChangeWaitType,
  parseMoveToPawn,
  parseServerMoveToLocation,
  parseStopMove,
  parseValidateLocation,
} from "@client/net/parsers/movement";

const IN = OPCODES.game.in;

/**
 * Turns one decrypted IN_GAME packet body into a world event. Returns null for an opcode we do
 * not handle, and for the empty NpcInfo body a decayed npc is sent with. Throws whatever the
 * parser throws (a RangeError on a short body) - the caller logs and carries on.
 */
export function dispatchWorldPacket(body: Uint8Array): WorldEvent | null {
  switch (body[0]) {
    case IN.NpcInfo: {
      const info = parseNpcInfo(body);

      return info === null ? null : { kind: "npcInfo", info };
    }
    case IN.ServerObjectInfo:
      return { kind: "npcInfo", info: parseServerObjectInfo(body) };
    case IN.CharInfo:
      return { kind: "charInfo", info: parseCharInfo(body) };
    case IN.DeleteObject:
      return { kind: "delete", objectId: parseDeleteObject(body).objectId };
    case IN.MoveToLocation:
      return { kind: "move", move: parseServerMoveToLocation(body) };
    case IN.MoveToPawn:
      return { kind: "moveToPawn", move: parseMoveToPawn(body) };
    case IN.StopMove:
      return { kind: "stop", location: parseStopMove(body) };
    case IN.ValidateLocation:
      return { kind: "validate", location: parseValidateLocation(body) };
    case IN.TeleportToLocation:
      return { kind: "teleport", teleport: parseTeleportToLocation(body) };
    case IN.Die:
      return { kind: "die", death: parseDie(body) };
    case IN.Revive:
      return { kind: "revive", object: parseRevive(body) };
    case IN.ChangeMoveType:
      return { kind: "moveType", change: parseChangeMoveType(body) };
    case IN.ChangeWaitType:
      return { kind: "waitType", change: parseChangeWaitType(body) };
    case IN.SocialAction:
      return { kind: "social", action: parseSocialAction(body) };
    case IN.Attack:
      return { kind: "attack", attack: parseAttack(body) };
    case IN.StatusUpdate:
      return { kind: "status", status: parseStatusUpdate(body) };
    case IN.MagicSkillUse:
      return { kind: "skill", skill: parseMagicSkillUse(body) };
    case IN.AutoAttackStart:
      return { kind: "combatStance", objectId: parseAutoAttack(body).objectId, inCombat: true };
    case IN.AutoAttackStop:
      return { kind: "combatStance", objectId: parseAutoAttack(body).objectId, inCombat: false };
    default:
      return null;
  }
}

export default dispatchWorldPacket;
