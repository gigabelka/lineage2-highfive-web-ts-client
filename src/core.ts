import RenderManager from "./rendering/render-manager";
import { BoxHelper } from "three";

import AssetManager from "@client/assets/asset-manager";
import attachNetSession from "@client/game/net-world-bridge";
import loadNetConfig from "@client/net/config";
import runSectorPrecache from "@client/sector-precache";
import RAPIER from "@dimforge/rapier3d";

async function startCore() {
  await RAPIER.init(); // rapier3d-compat loads its wasm lazily - must resolve before any RAPIER.World

  if ("storage" in navigator) await navigator.storage.persist();

  const startTime = performance.now();

  const texturesOverride = new URLSearchParams(location.search).get("textures");
  const textures: "auto" | "rgba" | "compressed" =
    texturesOverride === "rgba" || texturesOverride === "compressed"
      ? texturesOverride
      : "auto";

  const loadSettings: GD.LoadSettings_T = {
    helpersZoneBounds: false,
    batching: {
      terrain: true,
      staticMeshes: true,
    },
    cache: {
      enabled: true,
      version: 15, // bump when decode logic changes, invalidates all previously cached sectors
    },
    decodeWorkerPoolSize: 3, // num workers, 0 will run on main thread
    textures,
    loadTerrain: true,
    loadBaseModel: true,
    loadStaticModels: true,
    loadEmitters: true,
    loadAudio: true,
    loadCharacter: true, // player pawn: physics ticks, click-to-move
    loadPawns: false, // non-player pawns auto-loaded from a sector - not read anywhere yet, NPCs are spawned on demand from the NPC debug panel instead
    loadNpcs: false, // ditto
    _loadEmitterList: [],
    _loadStaticModelList: [
      "StaticMeshActor49",
      /* church indoors too dark */ "StaticMeshActor6" /* church outdoors */,
    ],
  } as const;

  if (new URLSearchParams(location.search).has("precacheSectors")) {
    await runSectorPrecache(loadSettings);
    return;
  }

  const viewport = document.querySelector("viewport") as HTMLViewportElement;
  const assetList = await (await fetch("/asset-list.json")).json();
  const assetManager = new AssetManager(loadSettings, assetList.supported);
  const renderManager = new RenderManager(viewport, assetManager);

  (global as any).renderManager = renderManager;

  /* Live-server session. Fire-and-forget on purpose: the handshake runs concurrently with
     asset initialization below (the slow part), so the coordinates normally land before
     startRendering() and the first AssetManager.tick. Nothing here is awaited - a dead server,
     a missing .env or a bad password must never stop the renderer from booting; failures show
     up in the HUD, in one console.error, and in `l2Session.snapshot`. */
  const netConfig = loadNetConfig();

  if (netConfig.enabled) {
    (global as any).l2Session = attachNetSession(renderManager, netConfig);
  }

  const objectGroup = renderManager.objectGroup;

  await assetManager.initialize(renderManager);

  renderManager.addClippingRangeControls();
  renderManager.addDisplayGammaControls();
  renderManager.addNpcControls();

  try {
    await renderManager.addCharacterControls();
  } catch (e) {
    console.warn(`[character] Character panel not available: ${(e as Error).message}`);
  }

  console.info(
    `System has loaded in ${(performance.now() - startTime) / 1000}s!`,
  );

  renderManager.scene.add(objectGroup);
  renderManager.scene.add(new BoxHelper(objectGroup));
  renderManager.startRendering();
}

export default startCore;
