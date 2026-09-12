import RenderManager from "@client/rendering/render-manager";
import { WebGLCapabilities } from "three/src/renderers/webgl/WebGLCapabilities.js";
import {
  createSectorStaticMeshDecodeJob,
  decodeObject3D,
  decodePackage,
  decodeSectorCore,
  stepSectorStaticMeshDecodeJob,
  SectorStaticMeshDecodeJob_T,
} from "@client/assets/decoders/object3d-decoder";
import decodeEnv from "@client/assets/decoders/env-decoder";
import DecodeWorkerClient from "@client/assets/decode-worker/decode-worker-client";
import { getUserConfig } from "@unreal/conf-files/un-conf-system";
import { AnimationClip, Matrix4, SkinnedMesh, Vector3 } from "three";
import type { SectorObject } from "@client/objects/zone-object";
import BaseActor from "@client/base-actor";
import Player from "@client/player";
import NpcSimulationComponent from "@client/physics/components/npc-simulation-component";

const tmpCameraPosition = new Vector3();
const tmpAttachMatrix = new Matrix4();
const tmpNpcFloorStart = new Vector3();
const npcFloorDirection = new Vector3(0, 0, -1);
const npcSpawnOffset = new Vector3(-600, -600, 0);

const FAILED_SECTOR_RETRY_MS = 30_000;
const RETIRED_SECTOR_DISPOSE_MS = 30_000;
const SECTOR_WORLD_SIZE = 256 * 128;
const SECTOR_PREFETCH_LOOKAHEAD_MS = 1500;
const SECTOR_PREFETCH_MAX_DISTANCE = SECTOR_WORLD_SIZE;
const STATIC_MESH_BUILD_FRAME_MS = 2;
const BIND_POSE_EPSILON = 1e-3;
const DEFAULT_CHAR_INDEX = 1;
const NPC_SPAWN_FLOOR_DISTANCE = 2000;
/** Ten character decodes at once starve the shared decode-worker pool - see AssetManager.simulatePawns. */
const PAWN_DECODE_CONCURRENCY = 3;
const SIMULATE_PAWN_SPREAD = 400;

const tmpPrefetchPosition = new Vector3();
const tmpCameraMovement = new Vector3();

/** `decodeCharacter`'s own default: bare body, no armour pieces selected. */
const DEFAULT_ARMOR_SELECTION: GD.ICharacterArmorSelection = {
  chest: 0,
  legs: 0,
  gloves: 0,
  boots: 0,
};

type WarriorAnimations_T = {
  wait: string;
  walk: string;
  run: string;
  death: string;
  falling: string;
  swim: string;
  swimWait: string;
};

/**
 * --- character / skeletal-actor decode seam -----------------------------------------------
 *
 * These `DecodeWorkerClient` RPCs are all implemented now:
 *
 *   decodeCharacter(settings, charIndex, faceVariant, hairVariant, hairColour, armor): Promise<GD.DecodeLibrary>
 *   decodeSkeletalMesh(settings, packageName, meshName, scriptClassPath, texturePaths, npcId): Promise<GD.DecodeLibrary>
 *   getClientConfig(): { userConfig, warriorAnimations }   (class -> clip names, alongside the existing
 *                                                          sector-scoped `getUserConfig()`)
 *   getCharGroups(): GD.ICharacterGroup[]
 *   resolveNpc(selector): GD.INpcDefinition
 *
 * Every call still goes through the class's `decodeCharacterLibrary` / `decodeSkeletalMeshLibrary` /
 * `getCharGroups` / `resolveNpc` / `loadCharacterConfig` shims below via `requireWorkerMethod` -
 * kept as the one place that knows each RPC's argument order and reports a clear message if a
 * future refactor ever drops one of these methods from `DecodeWorkerClient`.
 */
function requireWorkerMethod<F extends (...args: any[]) => any>(
  client: DecodeWorkerClient,
  name: string,
): F {
  const method = (client as any)[name] as F;

  if (typeof method !== "function")
    throw new Error(
      `DecodeWorkerClient.${name}() is not implemented yet (Phase 3 decode workstream).`,
    );

  return method;
}

type PendingStaticMeshBuild_T = {
  sector: SectorObject;
  library: GD.DecodeLibrary;
  decodeJob: SectorStaticMeshDecodeJob_T;
};

/**
 * Streams the world in and out around the camera. All ue2 asset decoding happens in
 * the decode worker (its own webpack bundle) - this side only ever sees plain decoded
 * data and instantiates three.js objects from it.
 */
class AssetManager {
  protected isTicking: boolean = false;
  protected loadSettings: GD.LoadSettings_T;
  protected glCapabilities: WebGLCapabilities;
  protected decodeWorker: DecodeWorkerClient = null;
  protected isWorkerReady = false;
  protected failedSectors = new Map<string, number>(); // sector id -> retry-after timestamp
  protected retiredSectors = new Map<
    string,
    { sector: SectorObject; retiredAt: number }
  >(); // hidden, awaiting disposal
  protected inFlightSectors = new Set<string>(); // sector ids currently decoding, so a boundary crossing can't re-request them

  protected readonly pendingStaticMeshBuilds: PendingStaticMeshBuild_T[] = [];
  protected readonly levelSectors = new Set<string>(); // sector ids that have a level package
  protected preferCompressedTextures = false; // resolved from loadSettings.textures + gpu caps
  public userConfig: GA.IUserConfig = null;
  /** `assets/system/lineagewarrior.int` clip names per character class; filled by `loadCharacterConfig`. */
  protected warriorAnimations: Record<string, WarriorAnimations_T> = null;
  /** Character groups (group/face/hair/armour options) the Character debug panel builds `loadCharacter` from. */
  protected charGroups: GD.ICharacterGroup[] = null;
  protected readonly decodeWorkerPoolSize: number;
  protected readonly maxConcurrentDecodes: number; // 0 = main thread, still processes one decode at a time
  protected readonly lastCameraPosition = new Vector3();
  protected lastCameraSampleTime = 0;

  /**
   * Sectors whose bounds intersect this radius around the camera or its projected
   * position get loaded. Unloading only kicks in past the larger radius so boundary
   * crossings don't thrash.
   */
  protected readonly renderDistance = SECTOR_WORLD_SIZE / 2;
  protected readonly unloadDistance = SECTOR_WORLD_SIZE;

  public constructor(
    loadSettings: GD.LoadSettings_T,
    assetList: Record<string, string>,
  ) {
    this.loadSettings = loadSettings;
    this.decodeWorkerPoolSize = loadSettings.decodeWorkerPoolSize ?? 3;
    this.maxConcurrentDecodes = Math.max(this.decodeWorkerPoolSize, 1);

    /* level packages are <x>_<y>.unr - keep the sector ids for map-edge validity checks */
    for (const path of Object.keys(assetList)) {
      if (!path.endsWith(".unr")) continue;

      this.levelSectors.add(
        path.slice(path.lastIndexOf("/") + 1, -".unr".length),
      );
    }
  }

  public hasSector(sectorIdx: string): boolean {
    return this.levelSectors.has(sectorIdx.toLowerCase());
  }

  public async initialize(renderManager: RenderManager): Promise<void> {
    this.glCapabilities = renderManager.renderer.capabilities;

    // with s3tc the dxt data uploads as-is (full mip chain, 4-8x less vram),
    // otherwise the worker converts to rgba like before
    const textureMode = (this.loadSettings as any).textures ?? "auto";
    const hasS3TC = !!renderManager.renderer.extensions.get(
      "WEBGL_compressed_texture_s3tc",
    );

    this.preferCompressedTextures =
      textureMode === "compressed" || (textureMode === "auto" && hasS3TC);
    (this.loadSettings as any).rgbaTextures = !this.preferCompressedTextures;

    console.info(
      `[textures] mode=${textureMode}, s3tc=${hasS3TC} -> uploading ${this.preferCompressedTextures ? "compressed DDS" : "converted RGBA"}`,
    );

    this.userConfig = await getUserConfig();

    /* Character-class config rides the same transport as the sector pipeline. Until the decode
       workstream lands its RPCs the character load path stays unavailable and says so - this must
       never block boot, hence the swallowed error below (see decodeCharacterLibrary's message). */
    await this.loadCharacterConfig();

    /* everything below comes out of the decode worker - the app cannot run without it */
    this.decodeWorker = new DecodeWorkerClient(this.decodeWorkerPoolSize);
    await this.decodeWorker.ready;
    this.isWorkerReady = true;

    const envInfo = await this.decodeWorker.decodeEnv();
    const musicInfo = await this.decodeWorker.getMusicInfo();
    const skyLibrary = await this.decodeWorker.decodeSector("skylevel", {
      ...this.loadSettings,
      isSkyLevel: true,
      loadTerrain: true,
      loadBaseModel: true,
      loadStaticModels: false,
      loadEmitters: false,
      loadStaticModelList: undefined,
      loadAudio: false,
      batching: { staticMeshes: false, terrain: false },
    });

    skyLibrary.anisotropy = this.glCapabilities.getMaxAnisotropy();
    (skyLibrary as any).preferCompressedTextures =
      this.preferCompressedTextures;

    renderManager.setEnv(decodeEnv(envInfo));
    renderManager.setSky(decodePackage(skyLibrary));
    renderManager.audioManager.setMusicInfo(musicInfo);

    /*
     * The player pawn's body. Today this lands in the catch below with the seam's message (the
     * character decode RPCs are still landing on the decode side), which is deliberately non-fatal:
     * the world still streams without a character. Once `decodeCharacter` exists this becomes the
     * whole character path with no further wiring; a deliberate character swap (Phase 8 GUI) goes
     * through the public `loadCharacter` instead.
     */
    if (this.loadSettings.loadCharacter) {
      try {
        await this.loadCharacter(
          renderManager,
          DEFAULT_CHAR_INDEX,
          0,
          0,
          0,
          DEFAULT_ARMOR_SELECTION,
        );
      } catch (e) {
        console.warn(
          `[character] player body not loaded: ${(e as Error).message}`,
        );
      }
    }
  }

  // --- character / skeletal actor (non-sector-scoped, see the decode seam note above) --------

  protected async loadCharacterConfig(): Promise<void> {
    try {
      const [clientConfig, charGroups] = await Promise.all([
        this.getClientConfig(),
        this.getCharGroups(),
      ]);

      this.warriorAnimations = clientConfig?.warriorAnimations ?? null;
      this.charGroups = charGroups ?? null;
    } catch (e) {
      console.warn(`[character] client config unavailable: ${(e as Error).message}`);
    }
  }

  public async getCharGroups(): Promise<GD.ICharacterGroup[]> {
    const getCharGroups = requireWorkerMethod<
      () => Promise<GD.ICharacterGroup[]>
    >(this.decodeWorker, "getCharGroups");

    return getCharGroups.call(this.decodeWorker);
  }

  /** `DecodeWorkerClient.resolveNpc` - Npcgrp.dat/npcname-e.dat/entereventgrp.dat lookup by id or name. */
  protected async resolveNpc(selector: string | number): Promise<GD.INpcDefinition> {
    const resolveNpc = requireWorkerMethod<
      (selector: string | number) => Promise<GD.INpcDefinition>
    >(this.decodeWorker, "resolveNpc");

    return resolveNpc.call(this.decodeWorker, selector);
  }

  protected async getClientConfig(): Promise<{
    userConfig?: GA.IUserConfig;
    warriorAnimations?: Record<string, WarriorAnimations_T>;
  }> {
    const getClientConfig = requireWorkerMethod<() => Promise<any>>(
      this.decodeWorker,
      "getClientConfig",
    );

    return getClientConfig.call(this.decodeWorker);
  }

  /** `DecodeWorkerClient.decodeCharacter` - see the seam note above. */
  protected async decodeCharacterLibrary(
    charIndex: number,
    faceVariant: number,
    hairVariant: number,
    hairColour: number,
    armor: GD.ICharacterArmorSelection,
  ): Promise<GD.DecodeLibrary> {
    const decode = requireWorkerMethod<(...args: any[]) => Promise<GD.DecodeLibrary>>(
      this.decodeWorker,
      "decodeCharacter",
    );

    return decode.call(
      this.decodeWorker,
      this.loadSettings,
      charIndex,
      faceVariant,
      hairVariant,
      hairColour,
      armor,
    );
  }

  /** `DecodeWorkerClient.decodeSkeletalMesh` - see the seam note above. */
  protected async decodeSkeletalMeshLibrary(
    packageName: string,
    meshName: string,
    scriptClassPath: string,
    texturePaths: string[],
    npcId: number,
  ): Promise<GD.DecodeLibrary> {
    const decode = requireWorkerMethod<(...args: any[]) => Promise<GD.DecodeLibrary>>(
      this.decodeWorker,
      "decodeSkeletalMesh",
    );

    return decode.call(
      this.decodeWorker,
      this.loadSettings,
      packageName,
      meshName,
      scriptClassPath,
      texturePaths,
      npcId,
    );
  }

  /**
   * Builds one playable character out of its decoded body parts and hands the result to `actor`
   * (the player by default). The parts share one skeleton where their bind poses match and the hair
   * chains hang off the head bone; the AnimationComponent then drives only the parts that own a bone
   * tree (`sharesSkeleton` / `isBoneAttachment` are skipped by `AnimationComponent.play`).
   */
  protected applyCharacter(
    renderManager: RenderManager,
    characterLibrary: GD.DecodeLibrary,
    actor?: BaseActor,
    charIndex: number = DEFAULT_CHAR_INDEX,
  ): void {
    characterLibrary.anisotropy = this.glCapabilities.getMaxAnisotropy();
    (characterLibrary as any).preferCompressedTextures =
      this.preferCompressedTextures;

    const bodyparts = characterLibrary.pawnActors.map(
      (info) => decodeObject3D(characterLibrary, info) as SkinnedMesh,
    );
    const animations = (bodyparts[0] as any).meshAnimations as Record<
      string,
      AnimationClip
    >;
    const player = actor || renderManager.player;

    if (!animations)
      throw new Error(`'${characterLibrary.name}' animations failed to decode.`);

    /* resolved before the body-part surgery below, so a missing character config fails before the
       parts are re-parented onto someone else's skeleton */
    const declared = this.getWarriorAnimations(charIndex);

    shareSkeletons(bodyparts);
    attachLooseBoneChains(bodyparts);

    /* The donor's `setPawnComponents()` call sits here; main attaches AnimationComponent and
       PawnRenderableComponent from `BaseActor`'s own constructor (guarded by findComponent, so the
       Phase 5-7 sound/effects/transform/npcLifecycle additions can use the same pattern). */
    player.setAnimations(animations);
    player.setIdleAnimation(findAnimation(animations, declared.wait));
    player.setWalkingAnimation(findAnimation(animations, declared.walk));
    player.setRunningAnimation(findAnimation(animations, declared.run));
    player.setDeathAnimation(findAnimation(animations, declared.death));
    player.setFallingAnimation(findAnimation(animations, declared.falling));
    player.setSwimmingAnimation(findAnimation(animations, declared.swim));
    player.setSwimmingIdleAnimation(findAnimation(animations, declared.swimWait));
    player.setMeshes(bodyparts);
    player.initAnimations();
  }

  /**
   * Rebuilds the player pawn's body from a character-class selection. Non-sector-scoped: unlike
   * `requestSector`, nothing here is keyed by a level sector or owned by the streaming lifetime.
   */
  public async loadCharacter(
    renderManager: RenderManager,
    charIndex: number,
    faceVariant: number,
    hairVariant: number,
    hairColour: number,
    armor: GD.ICharacterArmorSelection,
    actor?: BaseActor,
  ): Promise<void> {
    this.applyCharacter(
      renderManager,
      await this.decodeCharacterLibrary(
        charIndex,
        faceVariant,
        hairVariant,
        hairColour,
        armor,
      ),
      actor,
      charIndex,
    );

    renderManager.needsUpdate = true;
  }

  /**
   * Loads one skeletal mesh out of a package and wires it onto `actor` (an NPC, or actor-less for
   * props). Same non-sector-scoped contract as `loadCharacter`.
   *
   * The script half of the donor's version - `setScriptRuntime(new UnScriptVM(...))`, the effect
   * template object factory, `applyScriptLocalization` and `setDeathAnimationFromScript` - needs the
   * UnrealScript VM and lands in Phase 4. `scriptClassPath` is still forwarded to the decode RPC so
   * the returned library carries the script class that Phase 4 will bind.
   */
  public async loadSkeletalActor(
    renderManager: RenderManager,
    packageName: string,
    meshName: string,
    idleAnimation: string,
    actor: BaseActor,
    scriptClassPath: string = null,
    texturePaths: string[] = [],
    npcId: number = null,
    enterAnimation: string = null,
  ): Promise<GD.DecodeLibrary> {
    const library = await this.decodeSkeletalMeshLibrary(
      packageName,
      meshName,
      scriptClassPath,
      texturePaths,
      npcId,
    );

    library.anisotropy = this.glCapabilities.getMaxAnisotropy();
    (library as any).preferCompressedTextures = this.preferCompressedTextures;

    const meshes = library.pawnActors.map(
      (info) => decodeObject3D(library, info) as SkinnedMesh,
    );
    const animations = (meshes[0] as any).meshAnimations as Record<
      string,
      AnimationClip
    >;

    if (!animations)
      throw new Error(`'${library.name}' animations failed to decode.`);

    /* meshes with no usable clips still need placeholder entries so every movement state resolves */
    if (Object.keys(animations).length === 0) {
      animations[idleAnimation] = new AnimationClip(idleAnimation, 0, []);

      if (enterAnimation && enterAnimation.toLowerCase() !== "none")
        animations[enterAnimation] = new AnimationClip(enterAnimation, 0, []);
    }

    const idle = findNpcIdleAnimation(animations, idleAnimation);

    actor.setAnimations(animations);
    actor.setIdleAnimation(idle);
    actor.setWalkingAnimation(findNpcMovementAnimation(animations, "walk", idle));
    actor.setRunningAnimation(findNpcMovementAnimation(animations, "run", idle));
    actor.setDeathAnimation(idle);
    actor.setFallingAnimation(idle);
    actor.setSwimmingAnimation(idle);
    actor.setSwimmingIdleAnimation(idle);
    actor.setMeshes(meshes);
    actor.initAnimations();

    renderManager.needsUpdate = true;

    return library;
  }

  /**
   * Resolves `selector` against the Npcgrp.dat catalog and spawns it as a live pawn. `scriptClassPath`
   * is deliberately never forwarded here (unlike the donor project) - the UnrealScript VM is not
   * implemented yet (Phase 4), and `decodeSkeletalMesh` still throws on a non-null `scriptClassPath`,
   * so an NPC spawns with its mesh/animations/enter-event but no script-driven AI.
   */
  public async spawnNpc(
    renderManager: RenderManager,
    selector: string | number,
    position: Vector3 = null,
  ): Promise<BaseActor> {
    const npc = await this.resolveNpc(selector);
    const dot = npc.mesh.indexOf(".");

    if (dot < 0) throw new Error(`NPC '${npc.id}' has invalid mesh path '${npc.mesh}'.`);

    const actor = new BaseActor(renderManager);

    actor.name = npc.name || `Npc${npc.id}`;
    actor.position.copy(position || renderManager.player.position);
    if (!position) actor.position.add(npcSpawnOffset);

    try {
      await this.loadSkeletalActor(
        renderManager,
        npc.mesh.slice(0, dot),
        npc.mesh.slice(dot + 1),
        "Wait",
        actor,
        /* scriptClassPath */ null,
        npc.textures,
        npc.id,
        npc.enterEvent?.animation ?? null,
      );
    } catch (e) {
      throw new Error(
        `NPC '${npc.id}' (${npc.name}) failed to load mesh '${npc.mesh}': ${(e as Error).message}`,
        { cause: e },
      );
    }

    if (!position) {
      tmpNpcFloorStart.copy(actor.position);
      tmpNpcFloorStart.z += NPC_SPAWN_FLOOR_DISTANCE * 0.5;

      const floor = renderManager.rayCheck(
        tmpNpcFloorStart,
        npcFloorDirection,
        NPC_SPAWN_FLOOR_DISTANCE,
        undefined,
        undefined,
        false,
      );

      if (!floor) throw new Error(`NPC '${npc.id}' has no floor below its spawn position.`);

      actor.position.copy(floor.location);
    }

    try {
      renderManager.addPawn(actor);

      if (npc.enterEvent) actor.spawnEnterEvent(npc.enterEvent);
    } catch (e) {
      renderManager.removePawn(actor);
      throw e;
    }

    return actor;
  }

  /**
   * Debug "crowd" helper for the Character panel's Simulate Pawns button: spawns `count` random
   * character pawns near the player, each wandering for `NpcSimulationComponent.LIFETIME` ms before
   * despawning itself. Bounded decode concurrency, matching the donor's warning: decoding every
   * character at once starves the shared decode-worker pool that sector streaming also depends on.
   */
  public async simulatePawns(
    renderManager: RenderManager,
    count: number = NpcSimulationComponent.DEFAULT_COUNT,
  ): Promise<void> {
    const groups = this.charGroups ?? (this.charGroups = await this.getCharGroups());

    if (!groups || groups.length === 0)
      throw new Error("No character groups available to simulate pawns from.");

    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < count) {
        const index = next++;
        const group = groups[Math.floor(Math.random() * groups.length)];
        const hair = group.hairStyles[Math.floor(Math.random() * group.hairStyles.length)];
        const colours = group.hairColours[hair];
        const armor: GD.ICharacterArmorSelection = { chest: 0, legs: 0, gloves: 0, boots: 0 };
        const pawn = new Player(renderManager);

        for (const slot of Object.keys(armor) as (keyof GD.ICharacterArmorSelection)[]) {
          const items = group.armor[slot];

          armor[slot] = items.length > 0 && Math.random() < 0.75
            ? items[Math.floor(Math.random() * items.length)].id
            : 0;
        }

        pawn.name = `SimPawn${index}`;
        pawn.position.copy(renderManager.player.position);
        pawn.position.x += (Math.random() - 0.5) * SIMULATE_PAWN_SPREAD;
        pawn.position.y += (Math.random() - 0.5) * SIMULATE_PAWN_SPREAD;

        await this.loadCharacter(
          renderManager,
          group.index,
          Math.floor(Math.random() * group.faceVariants),
          hair,
          colours[Math.floor(Math.random() * colours.length)],
          armor,
          pawn,
        );

        pawn.addComponent(new NpcSimulationComponent()).configure(
          performance.now() + NpcSimulationComponent.LIFETIME,
          0,
        );
        renderManager.addPawn(pawn);
      }
    };

    const concurrency = Math.min(PAWN_DECODE_CONCURRENCY, count);
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) workers.push(worker());

    await Promise.all(workers);
  }

  protected getWarriorAnimations(charIndex: number): WarriorAnimations_T {
    if (!this.warriorAnimations || !this.charGroups)
      throw new Error(
        "Character config is not loaded - DecodeWorkerClient.getClientConfig()/getCharGroups() are part of the concurrent Phase 3 decode workstream.",
      );

    const className = this.getClassName(charIndex).toLowerCase();
    const declared = this.warriorAnimations[className];

    if (!declared)
      throw new Error(
        `'assets/system/lineagewarrior.int' has no '${className}' class.`,
      );

    return declared;
  }

  protected getClassName(charIndex: number): string {
    const group = this.charGroups.find((group) => group.index === charIndex);

    if (!group) throw new Error(`No character group for index ${charIndex}.`);

    return group.name;
  }

  public async setAlwaysLoaded(
    renderManager: RenderManager,
    sectorName: string,
  ) {
    const decodeLibrary = await this.decodeWorker.decodeSector(
      sectorName,
      this.loadSettings,
    );

    decodeLibrary.anisotropy = this.glCapabilities.getMaxAnisotropy();
    (decodeLibrary as any).preferCompressedTextures =
      this.preferCompressedTextures;

    const sector = decodePackage(decodeLibrary);

    sector.neverUnload = true;
    renderManager.addSector(sector);
  }

  /**
   * Dispatches a sector decode to the worker pool without waiting for it to finish, so
   * a boundary crossing can request the newly-important sector on a free worker instead
   * of queueing behind whatever a previous tick already asked for. Returns true when a
   * load was attempted (dispatched, or reused from the retired grace period), false when
   * the sector was skipped (already in flight, failure cooldown, pool full, worker dead).
   */
  protected requestSector(
    renderManager: RenderManager,
    sectorIdx: string,
    maxInFlight: number = this.maxConcurrentDecodes,
  ): boolean {
    const retired = this.retiredSectors.get(sectorIdx);

    if (retired) {
      /* still in its disposal grace period - reuse it as is, no re-decode */
      this.retiredSectors.delete(sectorIdx);
      renderManager.addSector(retired.sector);
      return true;
    }

    if (this.inFlightSectors.has(sectorIdx)) return false;

    const retryAt = this.failedSectors.get(sectorIdx);

    if (retryAt !== undefined && performance.now() < retryAt) return false;

    if (!this.isWorkerReady || this.decodeWorker.isDead) return false;
    if (this.inFlightSectors.size >= maxInFlight) return false; // pool full, retry next tick

    this.inFlightSectors.add(sectorIdx);

    this.decodeWorker
      .decodeSector(sectorIdx, this.loadSettings)
      .then((decodeLibrary) => {
        decodeLibrary.anisotropy = this.glCapabilities.getMaxAnisotropy();
        (decodeLibrary as any).preferCompressedTextures =
          this.preferCompressedTextures;

        const sector = decodeSectorCore(decodeLibrary); // static meshes built later by processPendingBuilds
        renderManager.addSector(sector);
        renderManager.gateParticleWarmup(sector, false); // ungated again once materials finish, see attachStaticMeshGroup

        this.pendingStaticMeshBuilds.push({
          sector,
          library: decodeLibrary,
          decodeJob: null,
        });
        this.failedSectors.delete(sectorIdx);
      })
      .catch((e) => {
        console.error(`Failed to decode sector '${sectorIdx}':`, e);
        this.failedSectors.set(
          sectorIdx,
          performance.now() + FAILED_SECTOR_RETRY_MS,
        );
      })
      .finally(() => {
        this.inFlightSectors.delete(sectorIdx);
      });

    return true;
  }

  /**
   * Hides the sector immediately but keeps it (and its package refcounts) intact for
   * RETIRED_SECTOR_DISPOSE_MS - returning within that window re-adds the retained
   * object with no re-decode. destroyExpiredSectors does the real cleanup afterwards.
   */
  protected retireSector(renderManager: RenderManager, sector: SectorObject) {
    const sectorIdx = `${sector.index.x}_${sector.index.y}`;

    // console.log(`Retiring sector '${sectorIdx}'.`);

    renderManager.removeSector(sector);
    this.retiredSectors.set(sectorIdx, {
      sector,
      retiredAt: performance.now(),
    });
  }

  /**
   * Disposes retired sectors past their grace period and releases the package
   * refcounts they took in the decode worker.
   */
  protected destroyExpiredSectors(renderManager: RenderManager) {
    const now = performance.now();

    for (const [sectorIdx, { sector, retiredAt }] of this.retiredSectors) {
      if (now - retiredAt < RETIRED_SECTOR_DISPOSE_MS) continue;

      // console.log(`Disposing sector '${sectorIdx}'.`);

      this.retiredSectors.delete(sectorIdx);
      renderManager.disposeSector(sector);

      this.decodeWorker?.freeSector(sectorIdx);
    }
  }

  protected processPendingBuilds(
    renderManager: RenderManager,
    cameraPosition: THREE.Vector3,
  ) {
    let jobIndex = -1;
    let jobDistance = Infinity;

    for (let i = 0; i < this.pendingStaticMeshBuilds.length; i++) {
      const sector = this.pendingStaticMeshBuilds[i].sector;
      const distance = sectorDistance(
        cameraPosition,
        sector.index.x,
        sector.index.y,
      );

      if (distance >= jobDistance) continue;

      jobIndex = i;
      jobDistance = distance;
    }

    const job = jobIndex < 0 ? null : this.pendingStaticMeshBuilds[jobIndex];

    if (!job) return;

    try {
      if (!job.decodeJob)
        job.decodeJob = createSectorStaticMeshDecodeJob(
          job.library,
          job.sector,
        );

      const deadline = performance.now() + STATIC_MESH_BUILD_FRAME_MS;
      let complete = false;

      do complete = stepSectorStaticMeshDecodeJob(job.decodeJob);
      while (!complete && performance.now() < deadline);

      if (!complete) return;

      this.pendingStaticMeshBuilds.splice(jobIndex, 1);
      renderManager.attachStaticMeshGroup(job.sector);
    } catch (e) {
      this.pendingStaticMeshBuilds.splice(jobIndex, 1);
      console.error(
        `Failed to build static meshes for sector '${job.sector.name}':`,
        e,
      );
    }
  }

  public async tick(renderManager: RenderManager) {
    if (this.isTicking) return; // avoid too many ticks running at the same time as the tick is done on before render so we defer sector loading

    try {
      this.isTicking = true;

      const cameraPosition =
        renderManager.camera.getWorldPosition(tmpCameraPosition);
      const [sx, sy] = renderManager.getSectorId(cameraPosition);
      const originIdx = `${sx}_${sy}`;
      const sectorsLoaded = renderManager.getLoadedSectors();
      const sectorsLoadedIds = sectorsLoaded.map(
        ({ index }) => `${index.x}_${index.y}`,
      );
      const isValidOrigin = this.hasSector(originIdx);
      const now = performance.now();
      const sampleDelta = now - this.lastCameraSampleTime;

      tmpPrefetchPosition.copy(cameraPosition);
      tmpCameraMovement.set(0, 0, 0);

      if (
        this.lastCameraSampleTime > 0 &&
        sampleDelta > 0 &&
        sampleDelta < 250
      ) {
        tmpCameraMovement
          .subVectors(cameraPosition, this.lastCameraPosition)
          .setZ(0)
          .multiplyScalar(SECTOR_PREFETCH_LOOKAHEAD_MS / sampleDelta);

        if (
          tmpCameraMovement.lengthSq() >
          SECTOR_PREFETCH_MAX_DISTANCE * SECTOR_PREFETCH_MAX_DISTANCE
        )
          tmpCameraMovement.setLength(SECTOR_PREFETCH_MAX_DISTANCE);

        tmpPrefetchPosition.add(tmpCameraMovement);
      }

      this.lastCameraPosition.copy(cameraPosition);
      this.lastCameraSampleTime = now;

      /*
       * Retire sectors past the unload radius; the gap between renderDistance and
       * unloadDistance keeps boundary crossings from thrashing. Retired sectors
       * stay reusable for a grace period before actually being disposed.
       */
      for (const sector of sectorsLoaded) {
        if (sector.neverUnload || !sector.index) continue;
        if (
          sectorDistance(cameraPosition, sector.index.x, sector.index.y) <=
          this.unloadDistance
        )
          continue;

        this.retireSector(renderManager, sector);
      }

      this.destroyExpiredSectors(renderManager);
      this.processPendingBuilds(renderManager, cameraPosition);

      /*
       * Sectors wanted this tick, most-important first: the sector the camera is
       * in, then any sector near the projected camera position, nearest-first.
       * Recomputing the list every tick makes a direction or boundary change
       * reprioritize the next available worker.
       */
      const sectorsToLoad: string[] = [];

      if (isValidOrigin && !sectorsLoadedIds.includes(originIdx))
        sectorsToLoad.push(originIdx);

      const ring = Math.ceil(this.renderDistance / SECTOR_WORLD_SIZE);
      const [psx, psy] = renderManager.getSectorId(tmpPrefetchPosition);
      const neighbours: { idx: string; dist: number; prefetchDist: number }[] =
        [];

      for (
        let x = Math.min(sx, psx) - ring, xmax = Math.max(sx, psx) + ring;
        x <= xmax;
        x++
      ) {
        for (
          let y = Math.min(sy, psy) - ring, ymax = Math.max(sy, psy) + ring;
          y <= ymax;
          y++
        ) {
          const levelIdx = `${x}_${y}`;

          if (levelIdx === originIdx || !this.hasSector(levelIdx)) continue; // skip origin and invalid sectors

          if (sectorsLoadedIds.includes(levelIdx)) continue;

          const dist = sectorDistance(cameraPosition, x, y);
          const prefetchDist = sectorDistance(tmpPrefetchPosition, x, y);

          if (
            dist <= this.renderDistance ||
            prefetchDist <= this.renderDistance
          )
            neighbours.push({ idx: levelIdx, dist, prefetchDist });
        }
      }

      neighbours.sort(
        (a, b) => a.prefetchDist - b.prefetchDist || a.dist - b.dist,
      );
      sectorsToLoad.push(...neighbours.map((n) => n.idx));

      const backgroundLimit =
        tmpCameraMovement.lengthSq() > 0
          ? Math.max(this.maxConcurrentDecodes - 1, 1)
          : this.maxConcurrentDecodes;

      for (let i = 0; i < sectorsToLoad.length; i++) {
        const isOrigin = i === 0 && sectorsToLoad[i] === originIdx;

        this.requestSector(
          renderManager,
          sectorsToLoad[i],
          isOrigin ? this.maxConcurrentDecodes : backgroundLimit,
        );
      }
    } finally {
      this.isTicking = false;
    }
  }
}

export default AssetManager;

// --- character body-part assembly -----------------------------------------------------------

function isHeadBone(name: string) {
  return /^bip01[ _]head$/i.test(name);
}

// system/lineagewarrior.int clip names are case-insensitive against package names.
function findAnimation(
  animations: Record<string, AnimationClip>,
  declared: string,
): string {
  const match = declared.toLowerCase();
  const name = Object.keys(animations).find(
    (name) => name.toLowerCase() === match,
  );

  if (!name) throw new Error(`Character has no '${declared}' animation.`);

  return name;
}

function findNpcIdleAnimation(
  animations: Record<string, AnimationClip>,
  declared: string,
): string {
  const names = Object.keys(animations);
  const match = declared.toLowerCase();
  const name =
    names.find((name) => name.toLowerCase() === match) ||
    names.find((name) => /^wait(?:_|$)/i.test(name)) ||
    names.find((name) => /^spwait/i.test(name)) ||
    names[0];

  if (!name) throw new Error(`NPC has no '${declared}' animation.`);

  return name;
}

function findNpcMovementAnimation(
  animations: Record<string, AnimationClip>,
  movement: string,
  idle: string,
): string {
  const names = Object.keys(animations);
  const index = idle.indexOf("_");
  const suffix = index < 0 ? "" : idle.slice(index);
  const match = `${movement}${suffix}`.toLowerCase();

  return (
    names.find((name) => name.toLowerCase() === match) ||
    names.find((name) => new RegExp(`^${movement}(?:_|$)`, "i").test(name)) ||
    idle
  );
}

/**
 * One skeleton per character where the bind poses match: the part that carries the head bone holds
 * it, every other part is re-bound to it and flagged so `AnimationComponent.play` skips it (a single
 * action then drives the whole body). The skipped part's own bone chain is detached - the host's
 * bones drive its skinning.
 */
function shareSkeletons(bodyparts: SkinnedMesh[]) {
  const host = bodyparts.find((part) =>
    part.skeleton.bones.some((bone) => isHeadBone(bone.name)),
  );

  if (!host)
    throw new Error(
      `Character has no bodypart carrying a head bone to share its skeleton from.`,
    );

  for (const part of bodyparts) {
    if (part === host || !isSameBindPose(host, part)) continue;

    part.remove(part.skeleton.bones[0]);
    part.bind(host.skeleton, part.bindMatrix);

    (part as any).sharesSkeleton = true;
  }
}

function isSameBindPose(host: SkinnedMesh, part: SkinnedMesh): boolean {
  const hostSkeleton = host.skeleton,
    partSkeleton = part.skeleton;

  if (hostSkeleton.bones.length !== partSkeleton.bones.length) return false;
  if (host.position.distanceTo(part.position) > BIND_POSE_EPSILON) return false;
  if (host.scale.distanceTo(part.scale) > BIND_POSE_EPSILON) return false;
  if (Math.abs(host.quaternion.dot(part.quaternion)) < 1 - BIND_POSE_EPSILON)
    return false;

  for (let i = 0, len = hostSkeleton.bones.length; i < len; i++) {
    if (hostSkeleton.bones[i].name !== partSkeleton.bones[i].name) return false;

    const hostInverse = hostSkeleton.boneInverses[i].elements,
      partInverse = partSkeleton.boneInverses[i].elements;

    for (let j = 0; j < 16; j++)
      if (Math.abs(hostInverse[j] - partInverse[j]) > BIND_POSE_EPSILON)
        return false;
  }

  return true;
}

/**
 * Hair meshes (ab/bh parts) carry their own loose bone chain rather than sharing the body skeleton.
 * Reparent that chain's root under the host's head bone, baking the offset into its local transform,
 * and flag the part so `AnimationComponent.play` leaves it alone - its chain rides the head bone and
 * its own `LocalSpaceSkeleton` poses it in attached mode.
 */
function attachLooseBoneChains(bodyparts: SkinnedMesh[]) {
  const host = bodyparts.find((part) =>
    part.skeleton.bones.some((bone) => isHeadBone(bone.name)),
  );

  if (!host)
    throw new Error(
      `Character has no bodypart carrying a head bone to attach its hair to.`,
    );

  const headBone = host.skeleton.bones.find((bone) => isHeadBone(bone.name));

  host.updateMatrixWorld(true);

  for (const part of bodyparts) {
    if (
      part === host ||
      !/(?:^|_)(?:ah|bh)$/i.test(part.name) ||
      part.skeleton.bones.some((bone) => isHeadBone(bone.name))
    )
      continue;

    const root = part.skeleton.bones[0];

    part.updateMatrixWorld(true);

    tmpAttachMatrix.copy(headBone.matrixWorld).invert().multiply(root.matrixWorld);
    tmpAttachMatrix.decompose(root.position, root.quaternion, root.scale);

    headBone.add(root);

    (part as any).isBoneAttachment = true;
  }
}

/**
 * Distance from the camera to a sector's bounds (0 inside it), using the same
 * sector -> world mapping as RenderManager.getSectorId.
 */
function sectorDistance(
  cameraPosition: THREE.Vector3,
  x: number,
  y: number,
): number {
  const minX = (x - 20) * SECTOR_WORLD_SIZE,
    maxX = minX + SECTOR_WORLD_SIZE;
  const minY = (y - 18) * SECTOR_WORLD_SIZE,
    maxY = minY + SECTOR_WORLD_SIZE;

  const dx = Math.max(minX - cameraPosition.x, 0, cameraPosition.x - maxX);
  const dy = Math.max(minY - cameraPosition.y, 0, cameraPosition.y - maxY);

  return Math.sqrt(dx * dx + dy * dy);
}
