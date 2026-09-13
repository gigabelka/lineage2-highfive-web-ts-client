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

  /* Live-server session. When enabled, NOTHING is rendered - no textures, no character, no
     location, not a single renderer.render() call - until the handshake below reaches IN_GAME
     (or gives up). assetManager.initialize() and renderManager.startRendering() are the only
     things that ever touch the GL canvas or decode assets, and both sit after `await connected`
     below, so the canvas stays untouched while only the DOM-based service windows (net HUD,
     lil-gui panel) are visible. This avoids burning a wasted streaming pass around the default
     startup camera position before the server hands over the character's real coordinates. A
     dead server, a missing .env or a bad password must still never stop the renderer from
     booting - `connected` also resolves on FAILED/DISCONNECTED; failures show up in the HUD, in
     one console.error, and in `l2Session.snapshot`. */
  const netConfig = loadNetConfig();
  let connected: Promise<void> = Promise.resolve();

  if (netConfig.enabled) {
    const net = attachNetSession(renderManager, netConfig);
    (global as any).l2Session = net.session;
    connected = net.connected;
  }

  const objectGroup = renderManager.objectGroup;

  await connected;
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
