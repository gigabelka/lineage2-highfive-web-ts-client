/**
 * The seam between the network session and the renderer.
 *
 * This is the ONLY file that imports both `src/net/**` and `RenderManager`: `src/net/` stays
 * free of three.js (so its specs run in vitest's node environment) and `RenderManager` stays
 * free of the network stack - it only gained generic public methods (`placePlayerAt`,
 * `releasePlayerHold`, `correctPlayerTo`, `stopPlayer`, `getPlayerLocation`,
 * `isPlayerHoldReleased`) and one generic callback (`onPlayerMoveRequest`), none of which know
 * they are backed by a network session.
 *
 * It owns everything the session itself must not know about: the coordinate-source priority
 * applied to the scene, the hand-off from the flying hold back to gravity once the target
 * sector's collision has streamed in, the outgoing MoveToLocation/ValidatePosition traffic, the
 * incoming ValidateLocation/StopMove corrections, and the HUD.
 */

import { Vector3 } from "three";

import type RenderManager from "@client/rendering/render-manager";
import type { CoordSource, CorrectionKind, SessionSnapshot } from "@client/net/session";
import type { NetConfig } from "@client/net/config";
import { L2Session } from "@client/net/session";
import { coordToTile } from "@client/net/world-tile";
import { createNetHud, type HudExtra } from "@client/net/net-hud";
import type { HeadedLocation } from "@client/net/parsers/movement";
import type AssetManager from "@client/assets/asset-manager";
import { WorldEntityRegistry } from "@client/game/world-entity-registry";

/** How often to check whether the target sector has streamed in. */
const HOLD_POLL_MS = 250;

/** Past this the sector is not coming; stay flying rather than sink out of the world. */
const HOLD_TIMEOUT_MS = 20000;

/** How often `watchForWorld` repeats its "still disabled" warning while it waits. */
const WORLD_WARN_INTERVAL_MS = 5000;

/* Mirrors the server's own MoveToLocation.java runImpl guards (see docs/networking.md) so we
   don't bother sending a click that the server would just answer with ActionFailed:
     - target == origin is rejected outright there, we treat "too close to re-send" the same way;
     - dx*dx + dy*dy > 98010000 (9900 units) is rejected as "too far";
     - closer than 17 units (geodata cell = 16) to the previous target is rejected as a dupe. */
const MAX_MOVE_DISTANCE_SQ = 98010000;
const MIN_MOVE_DISTANCE_SQ = 17 * 17;

export interface NetSessionHandle {
  session: L2Session;
  /** Resolves once the session reaches IN_GAME, or gives up (FAILED/DISCONNECTED). Never rejects. */
  connected: Promise<void>;
}

export function attachNetSession(
  renderManager: RenderManager,
  cfg: NetConfig,
  assetManager: AssetManager,
): NetSessionHandle {
  const position = new Vector3();
  /* Owns objectId -> actor and the spawn queue. It stays disabled until the sector under the
     player has collision - see `watchForWorld` below. */
  const world = new WorldEntityRegistry(renderManager, assetManager);

  let holdTimer: ReturnType<typeof setInterval> | null = null;
  let worldTimer: ReturnType<typeof setInterval> | null = null;
  let validateTimer: ReturnType<typeof setInterval> | null = null;
  let lastMoveTarget: Vector3 | null = null;
  let hudExtra: HudExtra = {};
  let lastSnapshot: SessionSnapshot | null = null;
  let resolveConnected: () => void;
  let settled = false;

  const stopHoldWatch = (): void => {
    if (holdTimer === null) return;
    clearInterval(holdTimer);
    holdTimer = null;
  };

  const stopWorldWatch = (): void => {
    if (worldTimer === null) return;
    clearInterval(worldTimer);
    worldTimer = null;
  };

  const stopValidateTicker = (): void => {
    if (validateTimer === null) return;
    clearInterval(validateTimer);
    validateTimer = null;
  };

  /**
   * ValidatePosition (0x59), sent at cfg.validateMs (retail's roughly-1Hz cadence). Gated on
   * `isPlayerHoldReleased()`: while the boot/spawn hold is up the pawn's Z is fiction (still
   * floating above not-yet-streamed collision), and the server would reject it via the
   * isFalling/z-range checks in ValidatePosition.java anyway - no point sending it yet.
   */
  const startValidateTicker = (): void => {
    stopValidateTicker();
    if (cfg.validateMs <= 0) return;

    validateTimer = setInterval(() => {
      if (!renderManager.isPlayerHoldReleased()) return;

      const loc = renderManager.getPlayerLocation();
      session.sendValidatePosition({ x: loc.x, y: loc.y, z: loc.z }, loc.heading);
    }, cfg.validateMs);
  };

  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const repaint = (): void => {
    if (lastSnapshot !== null) hud.update(lastSnapshot, { ...hudExtra, world: world.getCounts() });
  };

  /**
   * Wait for the sector the player was just placed in to exist (which is when its collidables are
   * registered with the CollisionWorld) AND for `RenderManager.isWorldReadyForPlayer` to go true
   * (geometry built, no decode in flight, no sector still waiting on a texture upload), then
   * release the flying hold. The player stays hidden the whole time (see `hidePlayerUntilReady`).
   */
  const watchForGround = (target: Vector3): void => {
    stopHoldWatch();

    const tile = coordToTile(target.x, target.y);

    if (!renderManager.hasSector(tile.id)) {
      /* The server put the character on a tile this asset install does not have. Visible and at
         the right coordinates beats invisible at the bottom of the world, so keep flying. */
      console.error(`[net] sector ${tile.id} is not in the asset install - the player stays flying`);
      renderManager.revealPlayer();
      /* The world is NOT left empty on this path any more: `watchForWorld` was started from
         `onPlace` alongside this watch and keeps waiting for collision here (it has no
         deadline). Whether anything may spawn is the registry's own call - a pawn spawned
         without collision under it holds its position instead of raining through the floor
         (AssetManager.spawnNpc's flying hold). */
      hudExtra = { ...hudExtra, tileAvailable: false, hold: "no-collision" };
      return repaint();
    }

    hudExtra = { ...hudExtra, tileAvailable: true, tileLoaded: false, hold: "held" };
    repaint();

    let startedAt = Date.now();

    holdTimer = setInterval(() => {
      /* The budget only starts once the streamer is running. `core.ts` awaits this handshake
         before `assetManager.initialize()`, and streaming only starts from `startRendering()`,
         so the 20s used to be consumed by a handshake that was still in progress - the timeout
         then fired against a sector nobody had asked for yet. */
      if (!assetManager.hasStreamedOnce()) {
        startedAt = Date.now();
        return;
      }

      if (renderManager.getSector(target) !== null) {
        if (hudExtra.tileLoaded !== true) {
          hudExtra = { ...hudExtra, tileLoaded: true };
          repaint();
        }

        if (renderManager.isWorldReadyForPlayer(target)) {
          stopHoldWatch();
          renderManager.releasePlayerHold();
          hudExtra = { ...hudExtra, hold: "released" };
          repaint();
        }

        return;
      }

      /* The deadline is about the PLAYER's own pawn only - showing it, and giving up on
         waiting for gravity. The world's gate is `watchForWorld`, which has no deadline. */
      if (Date.now() - startedAt >= HOLD_TIMEOUT_MS) {
        stopHoldWatch();
        console.warn(
          `[net] sector ${tile.id} did not stream in within ${HOLD_TIMEOUT_MS / 1000}s - the player stays flying`,
        );
        renderManager.revealPlayer();
        hudExtra = { ...hudExtra, hold: "no-collision" };
        repaint();
      }
    }, HOLD_POLL_MS);
  };

  /**
   * Waits for collision under `target` and only then lets `WorldEntityRegistry` spawn anything.
   *
   * Deliberately independent of `watchForGround`, deliberately weaker (it asks for the sector's
   * collidables, not for the whole streamer to have settled - the registry has its own per-entity
   * sector gate and its own flying hold), and deliberately without a deadline.
   *
   * The deadline is what used to break this: the only `world.setEnabled(true)` in the project sat
   * inside `watchForGround`'s tick, and both of that watch's exits - a tile missing from the asset
   * install, and a 20s timeout that started ticking before the first frame was ever rendered
   * (`core.ts` awaits the handshake before `assetManager.initialize()`, and streaming only starts
   * from `startRendering()`) - killed it for good. The world then stayed off for the whole session
   * with no other way in. Waiting forever here is harmless: nothing spawning is exactly what a
   * world with no collision under it should do.
   */
  const watchForWorld = (target: Vector3): void => {
    stopWorldWatch();

    const tile = coordToTile(target.x, target.y);
    let lastWarnAt = 0;

    hudExtra = { ...hudExtra, worldGate: "waiting" };
    repaint();

    worldTimer = setInterval(() => {
      if (renderManager.isSectorCollisionReady(target)) {
        stopWorldWatch();
        world.setEnabled(true);

        const counts = world.getCounts();

        hudExtra = { ...hudExtra, worldGate: "enabled" };
        console.info(
          `[world] enabled: ${counts.known} object(s) known, ${counts.pending} waiting to spawn`,
        );
        repaint();

        return;
      }

      /* Without this the gate is invisible: the HUD's `pending` stays 0 either way, and that
         silence is precisely what made the original bug take so long to find. */
      if (Date.now() - lastWarnAt < WORLD_WARN_INTERVAL_MS) return;

      lastWarnAt = Date.now();
      console.warn(`[world] still disabled: sector ${tile.id} collision not ready`);
    }, HOLD_POLL_MS);
  };

  const onPlace = (x: number, y: number, z: number, source: CoordSource): void => {
    position.set(x, y, z);
    renderManager.placePlayerAt(position);

    /* Only the authoritative source is worth waiting on the ground for; the CharSelectionInfo
       and CharSelected hints exist purely to start streaming during the handshake, and either
       may be superseded seconds later. */
    if (source === "userInfo") {
      /* Two watches off the same authoritative position, each with its own timer and its own
         fate: `watchForGround` releases the player's own flying hold and may give up (that is
         what its missing-tile branch and its timeout are for), `watchForWorld` gates the
         registry and never gives up. Starting the world watch here rather than from inside
         `watchForGround` is what keeps the first one's early exits from taking the second one
         down with it. */
      watchForGround(position.clone());
      watchForWorld(position.clone());
    } else hudExtra = { ...hudExtra, hold: "held" };
  };

  /**
   * A server-authoritative position correction. Deliberately bypasses `L2Session.place()` and
   * its `userInfo`-is-never-overridden coordinate priority - that rule exists for the initial
   * placement race between the three handshake hints, not for corrections arriving after the
   * character is already in the world, and routing them through `place()` would either be
   * silently dropped (once `userInfo` has already fired, which it always has by IN_GAME) or
   * would corrupt `coordSource`.
   */
  const onCorrection = (loc: HeadedLocation, kind: CorrectionKind): void => {
    position.set(loc.x, loc.y, loc.z);
    renderManager.correctPlayerTo(position, loc.heading);
    if (kind === "stopMove") renderManager.stopPlayer();
  };

  let lastPhase: SessionSnapshot["phase"] | null = null;

  const session = new L2Session(cfg, {
    onSnapshot: (snapshot) => {
      lastSnapshot = snapshot;

      if (snapshot.phase === "FAILED" || snapshot.phase === "DISCONNECTED") {
        stopHoldWatch();
        stopWorldWatch();
        stopValidateTicker();
        world.clear();
      }

      if (snapshot.phase === "IN_GAME" && lastPhase !== "IN_GAME") startValidateTicker();
      lastPhase = snapshot.phase;

      if (
        !settled &&
        (snapshot.phase === "IN_GAME" || snapshot.phase === "FAILED" || snapshot.phase === "DISCONNECTED")
      ) {
        settled = true;
        resolveConnected();
      }

      hud.update(snapshot, { ...hudExtra, world: world.getCounts() });
    },
    onPlace,
    onCorrection,
    onWorldEvent: (event) => world.handle(event),
  });

  /**
   * Click-to-move -> MoveToLocation (0x0F). Mirrors the server's own rejection guards (see the
   * constants above) so an obviously-doomed click never leaves the browser.
   */
  renderManager.onPlayerMoveRequest = (origin, destination) => {
    const dx = destination.x - origin.x;
    const dy = destination.y - origin.y;

    if (dx * dx + dy * dy > MAX_MOVE_DISTANCE_SQ) return;

    if (lastMoveTarget) {
      const ldx = destination.x - lastMoveTarget.x;
      const ldy = destination.y - lastMoveTarget.y;
      const ldz = destination.z - lastMoveTarget.z;
      if (ldx * ldx + ldy * ldy + ldz * ldz < MIN_MOVE_DISTANCE_SQ) return;
    }

    lastMoveTarget = destination.clone();

    session.sendMove(
      { x: destination.x, y: destination.y, z: destination.z },
      { x: origin.x, y: origin.y, z: origin.z },
      1, // mouse/click-to-move, see MoveToLocation.java
    );
  };

  const hud = createNetHud(() => {
    stopHoldWatch();
    stopWorldWatch();
    stopValidateTicker();
    world.clear();
    hudExtra = {};
    session.restart();
  });

  /* `world.clear()` above resets `enabled` to false, so the next `onPlace("userInfo")` raises
     the watcher again - there is nothing to remember across a reconnect. */
  (global as any).l2World = world;

  hud.update(session.snapshot, { ...hudExtra, world: world.getCounts() });
  session.start();

  return { session, connected };
}

export default attachNetSession;
