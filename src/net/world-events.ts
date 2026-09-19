/**
 * The one type that crosses the network -> game boundary for everything that is not our own
 * character. Plain data, three.js-free, so `src/net/**` keeps running under vitest's node
 * environment; `src/game/world-entity-registry.ts` is what turns these into actors.
 *
 * Every variant carries the objectId of the actor it is about, either directly or (Attack /
 * MagicSkillUse) as the attacker/caster id - the registry routes on that.
 */

import type { CharInfoBrief } from "@client/net/parsers/char-info";
import type { NpcInfoBrief } from "@client/net/parsers/npc-info";
import type {
  AttackInfo,
  SkillUseInfo,
  SocialActionInfo,
  StatusUpdateInfo,
} from "@client/net/parsers/combat";
import type {
  DeathInfo,
  ObjectRef,
  TeleportInfo,
} from "@client/net/parsers/object-lifecycle";
import type {
  HeadedLocation,
  MoveTypeChange,
  ServerMoveToLocation,
  ServerMoveToPawn,
  WaitTypeChange,
} from "@client/net/parsers/movement";

export type WorldEvent =
  /** NpcInfo 0x0C or ServerObjectInfo 0x92 - a creature entered view range (or was re-described). */
  | { kind: "npcInfo"; info: NpcInfoBrief }
  /** CharInfo 0x31 - another player entered view range. */
  | { kind: "charInfo"; info: CharInfoBrief }
  /** DeleteObject 0x08 - left view range, went invisible, or was removed. */
  | { kind: "delete"; objectId: number }
  | { kind: "move"; move: ServerMoveToLocation }
  | { kind: "moveToPawn"; move: ServerMoveToPawn }
  | { kind: "stop"; location: HeadedLocation }
  | { kind: "validate"; location: HeadedLocation }
  | { kind: "teleport"; teleport: TeleportInfo }
  | { kind: "die"; death: DeathInfo }
  | { kind: "revive"; object: ObjectRef }
  | { kind: "moveType"; change: MoveTypeChange }
  | { kind: "waitType"; change: WaitTypeChange }
  | { kind: "social"; action: SocialActionInfo }
  | { kind: "attack"; attack: AttackInfo }
  | { kind: "status"; status: StatusUpdateInfo }
  | { kind: "skill"; skill: SkillUseInfo }
  /** AutoAttackStart 0x25 / AutoAttackStop 0x26 - the combat stance toggling. */
  | { kind: "combatStance"; objectId: number; inCombat: boolean };

/**
 * The objectId a world event is about. Attack and MagicSkillUse name the actor performing the
 * action; everything else names the actor it happens to.
 */
export function worldEventObjectId(event: WorldEvent): number {
  switch (event.kind) {
    case "npcInfo":
      return event.info.objectId;
    case "charInfo":
      return event.info.objectId;
    case "delete":
      return event.objectId;
    case "move":
      return event.move.objectId;
    case "moveToPawn":
      return event.move.objectId;
    case "stop":
      return event.location.objectId;
    case "validate":
      return event.location.objectId;
    case "teleport":
      return event.teleport.objectId;
    case "die":
      return event.death.objectId;
    case "revive":
      return event.object.objectId;
    case "moveType":
      return event.change.objectId;
    case "waitType":
      return event.change.objectId;
    case "social":
      return event.action.objectId;
    case "attack":
      return event.attack.attackerId;
    case "status":
      return event.status.objectId;
    case "skill":
      return event.skill.casterId;
    case "combatStance":
      return event.objectId;
  }
}
