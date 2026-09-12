/**
 * Minimal connection-status overlay.
 *
 * A DOM overlay rather than a lil-gui folder: the `gui` instance in render-manager.ts is
 * module-private, so a folder would force either an export or moving this into that 2600-line
 * file. lil-gui is also a controls widget - read-only text that changes on every UserInfo and
 * pong renders as greyed-out disabled inputs and needs `.listen()` polling per controller.
 *
 * Created only when the session is enabled, so a no-network boot is unchanged.
 */

import type { SessionSnapshot } from "@client/net/session";

const UPDATE_INTERVAL_MS = 250;

export interface NetHud {
  update(snapshot: SessionSnapshot, extra?: HudExtra): void;
  destroy(): void;
}

export interface HudExtra {
  /** Whether the target tile exists in the local asset install. */
  tileAvailable?: boolean;
  /** Whether the tile has finished streaming in. */
  tileLoaded?: boolean;
  /** "held" while flying above not-yet-streamed collision, "released" once gravity is live. */
  hold?: "held" | "released" | "no-collision";
}

function ago(timestamp: number | null): string {
  if (timestamp === null) return "never";
  return `${Math.round((Date.now() - timestamp) / 1000)}s ago`;
}

function describeTile(snapshot: SessionSnapshot, extra: HudExtra): string {
  if (snapshot.tile === null) return "-";
  if (extra.tileAvailable === false) return `${snapshot.tile} MISSING from the asset install`;
  return `${snapshot.tile}${extra.tileLoaded ? " loaded" : " loading…"}`;
}

export function createNetHud(onReconnect: () => void): NetHud {
  const root = document.createElement("div");
  root.className = "l2-net-hud";

  const body = document.createElement("pre");
  body.className = "l2-net-hud__body";

  const button = document.createElement("button");
  button.className = "l2-net-hud__reconnect";
  button.type = "button";
  button.textContent = "Reconnect";
  button.addEventListener("click", onReconnect);

  root.append(body, button);
  document.body.appendChild(root);

  let pending: { snapshot: SessionSnapshot; extra: HudExtra } | null = null;
  let lastPaint = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const paint = (): void => {
    if (pending === null) return;

    const { snapshot, extra } = pending;
    pending = null;
    lastPaint = Date.now();

    root.classList.toggle("l2-net-hud--failed", snapshot.phase === "FAILED");
    root.classList.toggle("l2-net-hud--live", snapshot.phase === "IN_GAME");

    const coords = snapshot.coords;
    const lines = [
      `NET  ${snapshot.phase}${snapshot.detail ? `  ${snapshot.detail}` : ""}`,
      `char ${snapshot.charName ?? "-"}${snapshot.objectId !== null ? `  #${snapshot.objectId}` : ""}`,
      `pos  ${coords ? `${Math.round(coords.x)} / ${Math.round(coords.y)} / ${Math.round(coords.z)}  (${snapshot.coordSource})` : "-"}`,
      `tile ${describeTile(snapshot, extra)}`,
    ];

    if (extra.hold) lines.push(`hold ${extra.hold}`);

    if (snapshot.phase === "IN_GAME") {
      lines.push(`ping ${ago(snapshot.lastPongAt)}${snapshot.gameTime !== null ? `  gameTime ${snapshot.gameTime}` : ""}`);
    }

    body.textContent = lines.join("\n");
  };

  return {
    update(snapshot, extra = {}) {
      pending = { snapshot, extra };

      // Throttle: UserInfo, pongs and the tile watcher would otherwise repaint far too often.
      const since = Date.now() - lastPaint;

      if (since >= UPDATE_INTERVAL_MS) return paint();
      if (timer !== null) return;

      timer = setTimeout(() => {
        timer = null;
        paint();
      }, UPDATE_INTERVAL_MS - since);
    },

    destroy() {
      if (timer !== null) clearTimeout(timer);
      root.remove();
    },
  };
}

export default createNetHud;
