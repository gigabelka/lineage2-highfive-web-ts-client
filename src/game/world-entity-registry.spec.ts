/**
 * The registry's own invariants, with the renderer and the asset pipeline faked out.
 *
 * It reaches into three.js for exactly one value (`Vector3`) and holds everything else as
 * `import type`, so the node environment is enough - no WebGL, no decode workers, no DOM. The
 * fakes below are deliberately dumber than the real thing: they answer "is there collision under
 * this point" from a flag and "is this mesh loaded" from a function, which is all the registry is
 * allowed to ask them for.
 */

import { Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorldEntityRegistry } from "@client/game/world-entity-registry";
import type AssetManager from "@client/assets/asset-manager";
import type BaseActor from "@client/base-actor";
import type RenderManager from "@client/rendering/render-manager";
import { NPC_TYPE_ID_OFFSET, type NpcInfoBrief } from "@client/net/parsers/npc-info";
import type { WorldEvent } from "@client/net/world-events";

/** The registry's `DRAIN_INTERVAL_MS`, plus a margin - it is not exported. */
const DRAIN_INTERVAL_MS = 500;

/** Stands in for a streamed-in SectorObject; the registry only ever null-checks it. */
const SECTOR_TOKEN = { sector: true };

class FakeActor {
  public name = "";
  public readonly position = new Vector3();
  public collisionRadius = 0;
  public collisionHeight = 0;
  public walking = true;
  public yaw = 0;

  public setCollisionSize(radius: number, height: number): void {
    this.collisionRadius = radius;
    this.collisionHeight = height;
  }

  public setGroundSpeed(): void {
    /* recorded by the caller through the fake asset manager if a test ever needs it */
  }

  public setRotationYaw(yaw: number): void {
    this.yaw = yaw;
  }

  public setWalking(isWalking: boolean): void {
    this.walking = isWalking;
  }

  public teleportTo(position: Vector3): void {
    this.position.copy(position);
  }

  public goTo(): void {
    /* the spawn queue does not care whether the actor walked anywhere */
  }

  public stopMoving(): void {
    /* ditto */
  }

  public playDeathAnimation(): void {
    /* ditto */
  }

  public playMovementAnimation(): void {
    /* ditto */
  }

  public playAnimation(): void {
    /* ditto */
  }

  public getAnimationNames(): string[] {
    return [];
  }
}

class FakeRenderManager {
  public readonly player = { position: new Vector3() };
  public readonly added: FakeActor[] = [];
  public readonly removed: FakeActor[] = [];

  /** Flipped per test: "has the sector under this point registered its collidables yet". */
  public isReady: (position: Vector3) => boolean = () => true;

  public getSector(position: Vector3): unknown {
    return this.isReady(position) ? SECTOR_TOKEN : null;
  }

  public isSectorCollisionReady(position: Vector3): boolean {
    return this.isReady(position);
  }

  public addPawn(actor: FakeActor): void {
    this.added.push(actor);
  }

  public removePawn(actor: FakeActor): void {
    this.removed.push(actor);
  }
}

class FakeAssetManager {
  public readonly spawnCalls: { npcId: number; position: Vector3 }[] = [];
  public spawnImpl: (npcId: number) => Promise<FakeActor> = async () => new FakeActor();

  public async spawnNpc(
    _renderManager: unknown,
    selector: string | number,
    position: Vector3,
  ): Promise<FakeActor> {
    const npcId = selector as number;

    this.spawnCalls.push({ npcId, position: position.clone() });

    return this.spawnImpl(npcId);
  }

  public async getCharGroups(): Promise<GD.ICharacterGroup[]> {
    return [];
  }

  public async loadCharacter(): Promise<never> {
    throw new Error("character spawn is not exercised by these tests");
  }
}

function npcInfo(objectId: number, npcTypeId: number = NPC_TYPE_ID_OFFSET + 7): NpcInfoBrief {
  return {
    objectId,
    npcTypeId,
    isAttackable: false,
    x: 100,
    y: 200,
    z: 300,
    heading: 0,
    runSpeed: 120,
    walkSpeed: 60,
    collisionRadius: 9,
    collisionHeight: 27,
    isRunning: false,
    isInCombat: false,
    isAlikeDead: false,
    name: "",
    title: "",
  };
}

/** Lets every already-resolved await in the registry's spawn path run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe("WorldEntityRegistry", () => {
  let render: FakeRenderManager;
  let assets: FakeAssetManager;
  let registry: WorldEntityRegistry;

  beforeEach(() => {
    /* The drain timer is a real `setInterval`; fake timers keep it from outliving a test. */
    vi.useFakeTimers();
    /* Failed spawns warn by design - the tests that provoke them do not need the noise. */
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render = new FakeRenderManager();
    assets = new FakeAssetManager();
    registry = new WorldEntityRegistry(
      render as unknown as RenderManager,
      assets as unknown as AssetManager,
    );
  });

  afterEach(() => {
    registry.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const actor = (): BaseActor => new FakeActor() as unknown as BaseActor;

  it("tracks an object while the world is disabled and spawns it once the gate opens", async () => {
    registry.handle({ kind: "npcInfo", info: npcInfo(1) });

    /* Tracked, but the disabled gate swallows the queue push - the exact shape of the bug where
       `known` grew while `pending` stayed at 0. */
    expect(registry.getCounts()).toEqual({ live: 0, pending: 0, known: 1 });
    expect(assets.spawnCalls).toHaveLength(0);

    registry.setEnabled(true);
    await flush();

    expect(assets.spawnCalls).toHaveLength(1);
    expect(registry.getCounts()).toEqual({ live: 1, pending: 0, known: 1 });
  });

  it("leaves an entity queued until its sector has collision, and takes it on a later drain", async () => {
    render.isReady = () => false;
    registry.setEnabled(true);

    registry.handle({ kind: "npcInfo", info: npcInfo(1) });
    await flush();

    expect(assets.spawnCalls).toHaveLength(0);
    expect(registry.getCounts()).toEqual({ live: 0, pending: 1, known: 1 });

    render.isReady = () => true;
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS);
    await flush();

    expect(assets.spawnCalls).toHaveLength(1);
    expect(registry.getCounts()).toEqual({ live: 1, pending: 0, known: 1 });
  });

  it("stores the newest describe packet and retries a failed spawn only while attempts remain", async () => {
    registry.setEnabled(true);

    assets.spawnImpl = async () => {
      throw new Error("mesh unreadable");
    };

    registry.handle({ kind: "npcInfo", info: npcInfo(1, NPC_TYPE_ID_OFFSET + 7) });
    await flush();

    expect(registry.getCounts().live).toBe(0);

    /* The server re-describes the same object on the next region crossing - with a different
       template. The retry has to use the new one, not the packet the record was born from. */
    registry.handle({ kind: "npcInfo", info: npcInfo(1, NPC_TYPE_ID_OFFSET + 9) });
    await flush();

    expect(assets.spawnCalls.map((call) => call.npcId)).toEqual([7, 9]);
    expect(registry.getCounts().live).toBe(0);

    /* Two attempts spent: a third describe must not queue it again, or a permanently broken npc
       id would retry on every crossing. */
    registry.handle({ kind: "npcInfo", info: npcInfo(1, NPC_TYPE_ID_OFFSET + 11) });
    await flush();

    expect(assets.spawnCalls).toHaveLength(2);
    expect(registry.getCounts().live).toBe(0);
  });

  it("throws away an actor whose object is deleted while its mesh is still loading", async () => {
    registry.setEnabled(true);

    let releaseSpawn: ((actor: BaseActor) => void) | null = null;

    assets.spawnImpl = () =>
      new Promise<FakeActor>((resolve) => {
        releaseSpawn = resolve as (actor: FakeActor) => void;
      });

    registry.handle({ kind: "npcInfo", info: npcInfo(1) });
    await flush();

    /* `pending` counts the load in flight, so the entity is visible as queued work. */
    expect(registry.getCounts()).toEqual({ live: 0, pending: 1, known: 1 });

    registry.handle({ kind: "delete", objectId: 1 } as WorldEvent);
    releaseSpawn(actor());
    await flush();

    expect(render.removed).toHaveLength(1);
    expect(registry.getCounts()).toEqual({ live: 0, pending: 0, known: 0 });
  });

  it("despawns a live actor whose sector has been streamed out and re-queues its record", async () => {
    registry.setEnabled(true);

    registry.handle({ kind: "npcInfo", info: npcInfo(1) });
    await flush();

    expect(registry.getCounts().live).toBe(1);

    /* Live pawns are parented to `scene`, not to their sector, so unlike a map-placed pawn they
       survive the sector being unloaded - the drain sweep is what takes them off the graph. */
    render.isReady = () => false;
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS);
    await flush();

    expect(render.removed).toHaveLength(1);
    expect(registry.getCounts()).toEqual({ live: 0, pending: 1, known: 1 });
  });
});
