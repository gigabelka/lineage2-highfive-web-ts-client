/**
 * The seam between the network session and the renderer.
 *
 * This is the ONLY file that imports both `src/net/**` and `RenderManager`: `src/net/` stays
 * free of three.js (so its specs run in vitest's node environment) and `RenderManager` stays
 * free of the network stack (it only gained two generic public methods, `placePlayerAt` and
 * `releasePlayerHold`).
 *
 * It owns three things the session itself must not know about: the coordinate-source priority
 * applied to the scene, the hand-off from the flying hold back to gravity once the target
 * sector's collision has streamed in, and the HUD.
 */

import { Vector3 } from "three";

import type RenderManager from "@client/rendering/render-manager";
import type { CoordSource, SessionSnapshot } from "@client/net/session";
import type { NetConfig } from "@client/net/config";
import { L2Session } from "@client/net/session";
import { coordToTile } from "@client/net/world-tile";
import { createNetHud, type HudExtra } from "@client/net/net-hud";

/** How often to check whether the target sector has streamed in. */
const HOLD_POLL_MS = 250;

/**
 * Static-mesh building is time-sliced across frames after the sector object exists, so give it
 * a couple more polls before handing the pawn to gravity.
 */
const HOLD_EXTRA_POLLS = 2;

/** Past this the sector is not coming; stay flying rather than sink out of the world. */
const HOLD_TIMEOUT_MS = 20000;

export interface NetSessionHandle {
  session: L2Session;
  /** Resolves once the session reaches IN_GAME, or gives up (FAILED/DISCONNECTED). Never rejects. */
  connected: Promise<void>;
}

export function attachNetSession(renderManager: RenderManager, cfg: NetConfig): NetSessionHandle {
  const position = new Vector3();

  let holdTimer: ReturnType<typeof setInterval> | null = null;
  let hudExtra: HudExtra = {};
  let lastSnapshot: SessionSnapshot | null = null;
  let resolveConnected: () => void;
  let settled = false;

  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const stopHoldWatch = (): void => {
    if (holdTimer === null) return;
    clearInterval(holdTimer);
    holdTimer = null;
  };

  const repaint = (): void => {
    if (lastSnapshot !== null) hud.update(lastSnapshot, hudExtra);
  };

  /**
   * Wait for the sector the player was just placed in to exist (which is also when its
   * collidables are registered with the CollisionWorld), then release the flying hold.
   */
  const watchForGround = (target: Vector3): void => {
    stopHoldWatch();

    const tile = coordToTile(target.x, target.y);

    if (!renderManager.hasSector(tile.id)) {
      /* The server put the character on a tile this asset install does not have. Visible and at
         the right coordinates beats invisible at the bottom of the world, so keep flying. */
      console.error(`[net] sector ${tile.id} is not in the asset install - the player stays flying`);
      hudExtra = { ...hudExtra, tileAvailable: false, hold: "no-collision" };
      return repaint();
    }

    hudExtra = { ...hudExtra, tileAvailable: true, tileLoaded: false, hold: "held" };
    repaint();

    const startedAt = Date.now();
    let settledPolls = 0;

    holdTimer = setInterval(() => {
      if (renderManager.getSector(target) !== null) {
        if (hudExtra.tileLoaded !== true) {
          hudExtra = { ...hudExtra, tileLoaded: true };
          repaint();
        }

        settledPolls += 1;

        if (settledPolls > HOLD_EXTRA_POLLS) {
          stopHoldWatch();
          renderManager.releasePlayerHold();
          hudExtra = { ...hudExtra, hold: "released" };
          repaint();
        }

        return;
      }

      if (Date.now() - startedAt >= HOLD_TIMEOUT_MS) {
        stopHoldWatch();
        console.warn(
          `[net] sector ${tile.id} did not stream in within ${HOLD_TIMEOUT_MS / 1000}s - the player stays flying`,
        );
        hudExtra = { ...hudExtra, hold: "no-collision" };
        repaint();
      }
    }, HOLD_POLL_MS);
  };

  const onPlace = (x: number, y: number, z: number, source: CoordSource): void => {
    position.set(x, y, z);
    renderManager.placePlayerAt(position);

    /* Only the authoritative source is worth waiting on the ground for; the CharSelectionInfo
       and CharSelected hints exist purely to start streaming during the handshake, and either
       may be superseded seconds later. */
    if (source === "userInfo") watchForGround(position.clone());
    else hudExtra = { ...hudExtra, hold: "held" };
  };

  const session = new L2Session(cfg, {
    onSnapshot: (snapshot) => {
      lastSnapshot = snapshot;

      if (snapshot.phase === "FAILED" || snapshot.phase === "DISCONNECTED") stopHoldWatch();

      if (
        !settled &&
        (snapshot.phase === "IN_GAME" || snapshot.phase === "FAILED" || snapshot.phase === "DISCONNECTED")
      ) {
        settled = true;
        resolveConnected();
      }

      hud.update(snapshot, hudExtra);
    },
    onPlace,
  });

  const hud = createNetHud(() => {
    stopHoldWatch();
    hudExtra = {};
    session.restart();
  });

  hud.update(session.snapshot, hudExtra);
  session.start();

  return { session, connected };
}

export default attachNetSession;
