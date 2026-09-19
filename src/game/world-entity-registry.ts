/**
 * Turns the server's world broadcasts into live actors.
 *
 * Like `net-world-bridge.ts` this sits on the seam: it imports both `src/net/**` (as plain data
 * types only) and the renderer/asset side. `src/net/` itself stays three.js-free.
 *
 * What it owns:
 *   - the objectId -> actor map, which nothing else in the project has;
 *   - a bounded spawn queue, because `decodeSkeletalMesh`/`decodeCharacter` are pinned to decode
 *     worker 0 (DecodeWorkerClient.characterWorkerIndex) and a burst of NpcInfo packets would
 *     otherwise queue behind each other there and stall sector streaming with them;
 *   - the mapping from a CharInfo's race/sex/class onto a chargrp.dat group index.
 *
 * A record exists for every object the server has described, whether or not its mesh is loaded.
 * Positions and states are tracked on the record from the first packet, so an actor that spawns
 * later still appears where the server last put it.
 */

import { Vector3 } from "three";

import type AssetManager from "@client/assets/asset-manager";
import type BaseActor from "@client/base-actor";
import type RenderManager from "@client/rendering/render-manager";
import type { CharInfoBrief } from "@client/net/parsers/char-info";
import type { NpcInfoBrief } from "@client/net/parsers/npc-info";
import type { WorldEvent } from "@client/net/world-events";
import type PawnMovementComponent from "@client/physics/components/pawn-movement-component";
import Player from "@client/player";
import { CHAR_INFO_PAPERDOLL } from "@client/net/parsers/char-info";
import { NPC_TYPE_ID_OFFSET } from "@client/net/parsers/npc-info";
import { STATUS_ATTRIBUTE } from "@client/net/parsers/combat";
import { WAIT_TYPE } from "@client/net/parsers/movement";
import { worldEventObjectId } from "@client/net/world-events";

/**
 * How many mesh loads may be in flight at once. Both `spawnNpc` and `loadCharacter` route to
 * decode worker 0, which also serves the character bundle cache; `AssetManager.simulatePawns`
 * caps its own fan-out (PAWN_DECODE_CONCURRENCY) for the same reason.
 */
const SPAWN_CONCURRENCY = 2;

/** Hard ceiling on actors with a mesh. Records past it stay tracked and spawn as slots free up. */
const MAX_LIVE_ENTITIES = 60;

/**
 * How many mesh loads one record may start. The server re-describes an object every time it comes
 * back into view, and each of those is a chance to retry a load that failed for a transient
 * reason; without a ceiling a permanently broken npcId would retry on every region crossing.
 */
const SPAWN_MAX_ATTEMPTS = 2;

/** Re-drain the queue on this cadence, so entities waiting on a sector eventually get in. */
const DRAIN_INTERVAL_MS = 500;

/**
 * If the server's idea of where an actor is differs from ours by more than this, snap instead of
 * walking. Roughly four geodata cells - small drifts are what `goTo` is for.
 */
const SNAP_DISTANCE_SQ = 64 * 64;

type EntityKind = "npc" | "player";

type EntityState = "queued" | "loading" | "live" | "aborted" | "failed";

interface WorldEntity {
  objectId: number;
  kind: EntityKind;
  state: EntityState;
  actor: BaseActor | null;
  /** Last position the server reported, applied on spawn and kept up to date afterwards. */
  position: Vector3;
  heading: number;
  isDead: boolean;
  isRunning: boolean;
  hp: number | null;
  maxHp: number | null;
  name: string;
  /** The describe packet this record was created from, replayed when the mesh load starts. */
  npc: NpcInfoBrief | null;
  char: CharInfoBrief | null;
  /** Mesh loads started for this record; `SPAWN_MAX_ATTEMPTS` caps the retries a describe can trigger. */
  attempts: number;
}

/** Base classes with `isMage == true` in gameserver/model/actor/enums/player/PlayerClass.java. */
const MAGE_BASE_CLASSES = new Set([10, 25, 38, 49]);

/**
 * chargrp.dat group names per (race, branch, sex). The names are what
 * `DecodeEngine.decodeCharGroups` derives from each row's `face_mesh` - read off
 * c:/Games/HighFive/system/chargrp.dat, which holds 15 rows in this order: MFighter, FFighter,
 * MDarkElf, FDarkElf, MDwarf, FDwarf, MElf, FElf, MMagic, FMagic, MOrc, FOrc, MShaman, FShaman,
 * MKamael.
 *
 * Keyed by race ordinal as CharInfo sends it (Race.ordinal()): 0 human, 1 elf, 2 dark elf,
 * 3 orc, 4 dwarf, 5 kamael. Only human and orc split into a separate mage body; the other races
 * use one body for both branches. There is no female Kamael row, so she falls back to the male
 * one rather than to a human body.
 */
const CHAR_GROUP_NAMES: Record<number, { fighter: [string, string]; mage: [string, string] }> = {
  0: { fighter: ["MFighter", "FFighter"], mage: ["MMagic", "FMagic"] },
  1: { fighter: ["MElf", "FElf"], mage: ["MElf", "FElf"] },
  2: { fighter: ["MDarkElf", "FDarkElf"], mage: ["MDarkElf", "FDarkElf"] },
  3: { fighter: ["MOrc", "FOrc"], mage: ["MShaman", "FShaman"] },
  4: { fighter: ["MDwarf", "FDwarf"], mage: ["MDwarf", "FDwarf"] },
  5: { fighter: ["MKamael", "MKamael"], mage: ["MKamael", "MKamael"] },
};

const tmpPosition = new Vector3();

export class WorldEntityRegistry {
  private readonly renderManager: RenderManager;
  private readonly assetManager: AssetManager;
  private readonly entities = new Map<number, WorldEntity>();
  private readonly queue: WorldEntity[] = [];

  private loading = 0;
  private live = 0;
  private enabled = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  /** chargrp.dat group name -> its index, resolved once on the first CharInfo. */
  private charGroupIndices: Map<string, number> | null = null;
  private charGroupsPromise: Promise<void> | null = null;

  public constructor(renderManager: RenderManager, assetManager: AssetManager) {
    this.renderManager = renderManager;
    this.assetManager = assetManager;
  }

  /**
   * Spawning stays off until the sector under the player has collision (`net-world-bridge`'s
   * `watchForWorld`): before that the player's Z is a placeholder and the surrounding sector's
   * collision has not been built, so anything spawned would fall through the world. Records are
   * still kept while disabled, so switching on populates the world from what the server already
   * said rather than waiting for it to repeat.
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;

    this.enabled = enabled;

    if (!enabled) {
      this.stopDraining();

      return;
    }

    for (const entity of this.entities.values())
      if (entity.state === "queued" && !this.queue.includes(entity)) this.queue.push(entity);

    this.drain();
    this.startDraining();
  }

  /** Live actor count and how many records are still waiting, for the HUD. */
  public getCounts(): { live: number; pending: number; known: number } {
    return { live: this.live, pending: this.queue.length + this.loading, known: this.entities.size };
  }

  public handle(event: WorldEvent): void {
    const objectId = worldEventObjectId(event);

    switch (event.kind) {
      case "npcInfo":
        this.describeNpc(event.info);

        return;
      case "charInfo":
        this.describeChar(event.info);

        return;
      case "delete":
        this.remove(objectId);

        return;
      default:
        this.applyToEntity(objectId, event);
    }
  }

  /** Drops every actor. Called when the session dies or reconnects. */
  public clear(): void {
    this.stopDraining();

    for (const entity of this.entities.values()) {
      if (entity.actor) this.renderManager.removePawn(entity.actor);

      /* A load in flight cannot be cancelled - mark it so its completion throws the actor away
         instead of adding it to a world that has moved on. */
      entity.state = "aborted";
      entity.actor = null;
    }

    this.entities.clear();
    this.queue.length = 0;
    this.live = 0;
    this.enabled = false;
  }

  // --- describe ------------------------------------------------------------------------------

  private describeNpc(info: NpcInfoBrief): void {
    const existing = this.entities.get(info.objectId);

    /* Re-describing a known object is an update - the server re-sends info on region changes -
       not a second spawn. */
    if (existing) {
      this.redescribe(existing, info);

      return;
    }

    this.track({
      objectId: info.objectId,
      kind: "npc",
      state: "queued",
      actor: null,
      position: new Vector3(info.x, info.y, info.z),
      heading: info.heading,
      isDead: info.isAlikeDead,
      isRunning: info.isRunning,
      hp: null,
      maxHp: null,
      name: info.name,
      npc: info,
      char: null,
      attempts: 0,
    });
  }

  private describeChar(info: CharInfoBrief): void {
    const existing = this.entities.get(info.objectId);

    if (existing) {
      this.redescribe(existing, info);

      return;
    }

    this.track({
      objectId: info.objectId,
      kind: "player",
      state: "queued",
      actor: null,
      position: new Vector3(info.x, info.y, info.z),
      heading: info.heading,
      isDead: info.isAlikeDead,
      isRunning: info.isRunning,
      hp: null,
      maxHp: null,
      name: info.name,
      npc: null,
      char: info,
      attempts: 0,
    });
  }

  /**
   * A repeat describe for an object we already track - the server re-sends NpcInfo/CharInfo
   * whenever it comes back into view range. The packet itself is stored, not just the numbers read
   * out of it: a repeat after a region change carries a different mesh id, collision size, speeds
   * and equipment, and a later spawn has to replay the newest one rather than the one the record
   * was first created from.
   */
  private redescribe(entity: WorldEntity, info: NpcInfoBrief | CharInfoBrief): void {
    entity.position.set(info.x, info.y, info.z);
    entity.heading = info.heading;
    entity.isRunning = info.isRunning;
    entity.isDead = info.isAlikeDead;

    /* `npcTypeId` is what tells the two briefs apart; `entity.kind` would trust that an object id
       never changes kind. */
    if ("npcTypeId" in info) entity.npc = info;
    else entity.char = info;

    if (!entity.actor) {
      /* No actor: the spawn was either never started (world still disabled) or failed. A fresh
         describe is the cue to try again - but only while `attempts` has room, so a permanently
         broken npc id cannot retry on every region crossing. The state check keeps a load that is
         still in flight from being queued a second time. */
      if (entity.state !== "loading" && entity.attempts < SPAWN_MAX_ATTEMPTS) {
        entity.state = "queued";

        if (this.enabled && !this.queue.includes(entity)) {
          this.queue.push(entity);
          this.drain();
        }
      }

      return;
    }

    entity.actor.teleportTo(entity.position);
    entity.actor.setRotationYaw(info.heading);
  }

  private track(entity: WorldEntity): void {
    this.entities.set(entity.objectId, entity);

    if (!this.enabled) return;

    this.queue.push(entity);
    this.drain();
  }

  private remove(objectId: number): void {
    const entity = this.entities.get(objectId);

    if (!entity) return;

    this.entities.delete(objectId);

    const queued = this.queue.indexOf(entity);

    if (queued >= 0) this.queue.splice(queued, 1);

    if (entity.actor) {
      this.renderManager.removePawn(entity.actor);
      this.live -= 1;
      entity.actor = null;
    }

    /* A load already in flight checks this on completion and throws the actor away. */
    entity.state = "aborted";
  }

  // --- spawn queue ---------------------------------------------------------------------------

  private startDraining(): void {
    if (this.drainTimer !== null) return;

    this.drainTimer = setInterval(() => this.drain(), DRAIN_INTERVAL_MS);
  }

  private stopDraining(): void {
    if (this.drainTimer === null) return;

    clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private drain(): void {
    if (!this.enabled) return;

    this.sweepStrandedActors();

    while (
      this.queue.length > 0 &&
      this.loading < SPAWN_CONCURRENCY &&
      this.live + this.loading < MAX_LIVE_ENTITIES
    ) {
      const entity = this.takeNearest();

      if (entity === null) return;

      void this.spawn(entity);
    }
  }

  /**
   * Takes back the actors that the world has moved on from.
   *
   * A live pawn is parented to `scene`, not to the sector it stands in (`RenderManager.addPawn`),
   * so unlike a map-placed pawn it does not go away when its sector is streamed out - it would
   * stand in an unloaded void holding a `MAX_LIVE_ENTITIES` slot until a `DeleteObject` that may
   * never come (the server has no reason to send one for an object we merely walked away from).
   * Dropping it back to `queued` despawns it and frees the slot; if the player comes back and the
   * sector streams in again, the drain timer respawns it from the same record.
   */
  private sweepStrandedActors(): void {
    for (const entity of this.entities.values()) {
      const actor = entity.actor;

      if (entity.state !== "live" || !actor) continue;
      if (this.renderManager.getSector(actor.position) !== null) continue;

      this.renderManager.removePawn(actor);
      entity.actor = null;
      entity.state = "queued";
      this.live -= 1;

      if (!this.queue.includes(entity)) this.queue.push(entity);
    }
  }

  /**
   * Pops the queued entity closest to the player, skipping any whose sector has not streamed in
   * yet - those stay queued and are retried by the drain timer. Without the sector check an NPC
   * spawns into empty space with no collision under it and falls out of the world. The check asks
   * for the sector's collidables rather than merely for the sector existing: a sector that has
   * only decoded its terrain has no static-mesh geometry registered with the CollisionWorld yet.
   */
  private takeNearest(): WorldEntity | null {
    const origin = this.renderManager.player.position;

    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < this.queue.length; i++) {
      const entity = this.queue[i];

      if (entity.state !== "queued") continue;
      if (!this.renderManager.isSectorCollisionReady(entity.position)) continue;

      const distance = origin.distanceToSquared(entity.position);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) return null;

    return this.queue.splice(bestIndex, 1)[0];
  }

  private async spawn(entity: WorldEntity): Promise<void> {
    entity.attempts += 1;
    entity.state = "loading";
    this.loading += 1;

    try {
      const actor =
        entity.kind === "npc"
          ? await this.spawnNpcActor(entity)
          : await this.spawnPlayerActor(entity);

      /* The object may have left view range while its mesh was decoding. */
      if (entity.state !== "loading") {
        this.renderManager.removePawn(actor);

        return;
      }

      entity.actor = actor;
      entity.state = "live";
      this.live += 1;

      this.applyEntityState(entity);
    } catch (e) {
      /* One unreadable mesh must not take the world view down with it. Mark it failed rather than
         re-queueing, or a broken npc id would retry forever on the drain timer - `redescribe` is
         the only thing that tries again, and only while `SPAWN_MAX_ATTEMPTS` has room. */
      if (entity.state === "loading") entity.state = "failed";

      console.warn(`[world] object ${entity.objectId} failed to spawn: ${(e as Error).message}`);
    } finally {
      this.loading -= 1;
      this.drain();
    }
  }

  private async spawnNpcActor(entity: WorldEntity): Promise<BaseActor> {
    const info = entity.npc!;
    /* AbstractNpcInfo/ServerObjectInfo send displayId + 1000000; Npcgrp.dat is keyed by the raw
       id, which is what `resolveNpc` behind `spawnNpc` expects. */
    const npcId = info.npcTypeId - NPC_TYPE_ID_OFFSET;
    const actor = await this.assetManager.spawnNpc(
      this.renderManager,
      npcId,
      entity.position,
      /* playEnterEvent */ false,
    );

    actor.setCollisionSize(info.collisionRadius, info.collisionHeight);
    actor.setGroundSpeed(info.runSpeed, info.walkSpeed);

    /* The template only sends a name when it is `isUsingServerSideName()`; otherwise `spawnNpc`
       has already named the actor from npcname-e.dat and we must not blank that. */
    if (info.name.length > 0) actor.name = info.name;

    return actor;
  }

  private async spawnPlayerActor(entity: WorldEntity): Promise<BaseActor> {
    const info = entity.char!;
    const charIndex = await this.resolveCharIndex(info);
    const pawn = new Player(this.renderManager);

    pawn.name = info.name;
    pawn.position.copy(entity.position);

    /* Player's constructor raises the tick rate to 60 Hz for the locally controlled character.
       Other players are server-driven, so put them back on the 30 Hz pawn gate. */
    pawn.getComponent<PawnMovementComponent>("pawnMovement").setPhysicsTickRate(30);

    await this.assetManager.loadCharacter(
      this.renderManager,
      charIndex,
      info.face,
      info.hairStyle,
      info.hairColor,
      await this.resolveArmor(charIndex, info),
      pawn,
    );

    pawn.setCollisionSize(info.collisionRadius, info.collisionHeight);
    pawn.setGroundSpeed(info.runSpeed, info.walkSpeed);
    this.renderManager.addPawn(pawn);

    return pawn;
  }

  // --- CharInfo -> chargrp.dat -----------------------------------------------------------------

  private async loadCharGroups(): Promise<void> {
    const groups = await this.assetManager.getCharGroups();

    this.charGroupIndices = new Map(groups.map((group) => [group.name.toLowerCase(), group.index]));
  }

  private async resolveCharIndex(info: CharInfoBrief): Promise<number> {
    if (this.charGroupIndices === null) {
      this.charGroupsPromise ??= this.loadCharGroups();
      await this.charGroupsPromise;
    }

    const byRace = CHAR_GROUP_NAMES[info.race];
    const branch = byRace
      ? MAGE_BASE_CLASSES.has(info.baseClass)
        ? byRace.mage
        : byRace.fighter
      : null;
    const name = branch === null ? null : branch[info.isFemale ? 1 : 0];
    const index = name === null ? undefined : this.charGroupIndices!.get(name.toLowerCase());

    if (index === undefined) {
      /* Resolve by name, never by a hardcoded row number - chargrp.dat's order is not part of
         any protocol. A miss degrades to the first group rather than dropping the player. */
      console.warn(
        `[world] no chargrp group for race ${info.race} baseClass ${info.baseClass} (${info.isFemale ? "female" : "male"}); falling back to group 0`,
      );

      return 0;
    }

    return index;
  }

  /**
   * CharInfo carries item DISPLAY ids, while `loadCharacter` wants armorgrp.dat item ids. For
   * ordinary armour the two are the same number; anything the group does not offer (a weapon
   * slot, an unmodelled item, a display-id override) degrades to the naked body part rather
   * than failing the spawn.
   */
  private async resolveArmor(
    charIndex: number,
    info: CharInfoBrief,
  ): Promise<GD.ICharacterArmorSelection> {
    const groups = await this.assetManager.getCharGroups();
    const group = groups.find((candidate) => candidate.index === charIndex);
    const armor: GD.ICharacterArmorSelection = { chest: 0, legs: 0, gloves: 0, boots: 0 };

    if (!group) return armor;

    const slots: [keyof GD.ICharacterArmorSelection, number][] = [
      ["chest", CHAR_INFO_PAPERDOLL.CHEST],
      ["legs", CHAR_INFO_PAPERDOLL.LEGS],
      ["gloves", CHAR_INFO_PAPERDOLL.GLOVES],
      ["boots", CHAR_INFO_PAPERDOLL.FEET],
    ];

    for (const [slot, paperdoll] of slots) {
      const id = info.paperdollDisplayIds[paperdoll];

      if (id > 0 && group.armor[slot].some((option) => option.id === id)) armor[slot] = id;
    }

    return armor;
  }

  // --- per-actor events ------------------------------------------------------------------------

  private applyToEntity(objectId: number, event: WorldEvent): void {
    const entity = this.entities.get(objectId);

    if (!entity) return;

    switch (event.kind) {
      case "move":
        entity.position.set(event.move.dstX, event.move.dstY, event.move.dstZ);
        this.reconcile(entity, event.move.x, event.move.y, event.move.z);
        entity.actor?.goTo(entity.position);
        break;
      case "moveToPawn": {
        const target = this.entities.get(event.move.targetId);

        entity.position.set(event.move.targetX, event.move.targetY, event.move.targetZ);
        this.reconcile(entity, event.move.x, event.move.y, event.move.z);

        /* Following a live actor keeps the chase glued to it as it moves; falling back to its
           last known position is still better than standing still. */
        if (target?.actor) entity.actor?.goToActor(target.actor, event.move.distance);
        else entity.actor?.goTo(entity.position);
        break;
      }
      case "stop":
        entity.position.set(event.location.x, event.location.y, event.location.z);
        entity.heading = event.location.heading;
        entity.actor?.stopMoving();
        entity.actor?.teleportTo(entity.position);
        entity.actor?.setRotationYaw(event.location.heading);
        break;
      case "validate":
        entity.position.set(event.location.x, event.location.y, event.location.z);
        entity.heading = event.location.heading;
        this.reconcile(entity, event.location.x, event.location.y, event.location.z);
        entity.actor?.setRotationYaw(event.location.heading);
        break;
      case "teleport":
        entity.position.set(event.teleport.x, event.teleport.y, event.teleport.z);
        entity.heading = event.teleport.heading;
        entity.actor?.stopMoving();
        entity.actor?.teleportTo(entity.position);
        entity.actor?.setRotationYaw(event.teleport.heading);
        break;
      case "moveType":
        entity.isRunning = event.change.isRunning;
        entity.actor?.setWalking(!event.change.isRunning);
        break;
      case "waitType":
        this.applyWaitType(entity, event.change.waitType);
        break;
      case "die":
        if (entity.isDead) break;

        entity.isDead = true;
        /* The actor stays in the scene until DeleteObject - a corpse is lootable and the server
           decides when it decays. */
        entity.actor?.playDeathAnimation(noop);
        break;
      case "revive":
        if (!entity.isDead) break;

        entity.isDead = false;
        entity.actor?.playMovementAnimation("idle");
        break;
      case "status": {
        const hp = event.status.attributes.get(STATUS_ATTRIBUTE.CUR_HP);
        const maxHp = event.status.attributes.get(STATUS_ATTRIBUTE.MAX_HP);

        if (hp !== undefined) entity.hp = hp;
        if (maxHp !== undefined) entity.maxHp = maxHp;
        break;
      }
      case "attack": {
        const target = this.entities.get(event.attack.hits[0].targetId);

        if (target?.actor) entity.actor?.faceActor(target.actor);

        this.playOneShot(entity, "attack");
        break;
      }
      case "skill":
        this.playOneShot(entity, "cast");
        break;
      case "social":
        /* Social action ids have no client-side clip table yet, so there is nothing to play. */
        break;
      case "combatStance":
        /* Nothing visual hangs off the combat stance until weapon meshes land. */
        break;
      default:
        break;
    }
  }

  /** Applies whatever the record already knows to a freshly spawned actor. */
  private applyEntityState(entity: WorldEntity): void {
    const actor = entity.actor;

    if (!actor) return;

    actor.setRotationYaw(entity.heading);
    actor.setWalking(!entity.isRunning);

    if (entity.isDead) actor.playDeathAnimation(noop);
  }

  /**
   * The server tells us where the actor is as well as where it is going. Small differences are
   * simulation drift and are left for the movement component to walk off; a large one means we
   * lost track of it (it was out of view, or a packet was dropped) and is snapped.
   */
  private reconcile(entity: WorldEntity, x: number, y: number, z: number): void {
    const actor = entity.actor;

    if (!actor) return;

    tmpPosition.set(x, y, z);

    if (actor.position.distanceToSquared(tmpPosition) > SNAP_DISTANCE_SQ)
      actor.teleportTo(tmpPosition);
  }

  private applyWaitType(entity: WorldEntity, waitType: number): void {
    const actor = entity.actor;

    if (!actor) return;

    switch (waitType) {
      case WAIT_TYPE.SITTING:
        this.playOneShot(entity, "sit");
        break;
      case WAIT_TYPE.STANDING:
        actor.playMovementAnimation("idle");
        break;
      case WAIT_TYPE.START_FAKEDEATH:
        entity.isDead = true;
        actor.playDeathAnimation(noop);
        break;
      case WAIT_TYPE.STOP_FAKEDEATH:
        entity.isDead = false;
        actor.playMovementAnimation("idle");
        break;
      default:
        break;
    }
  }

  /**
   * Plays a one-shot clip if this mesh happens to have one whose name starts with `prefix`.
   * Deliberately tolerant: clip names differ wildly between NPC meshes and character classes,
   * and `AnimationComponent.play` on a missing clip throws. A creature with no matching clip
   * simply does not animate, which is a far better failure than a dropped packet handler.
   */
  private playOneShot(entity: WorldEntity, prefix: string): void {
    const actor = entity.actor;

    if (!actor || entity.isDead) return;

    const name = actor
      .getAnimationNames()
      .find((candidate) => candidate.toLowerCase().startsWith(prefix));

    if (name === undefined) return;

    actor.playAnimation(name, 0.1, 1, false, true);
  }
}

/** `playDeathAnimation` requires a completion callback; nothing needs to happen on one here. */
function noop(): void {
  /* intentionally empty */
}

export default WorldEntityRegistry;
