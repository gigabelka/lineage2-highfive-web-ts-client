/* TEMPORARY probe harness v4 - full DecodeEngine.decodeSkeletalMesh in Node */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

async function main() {
  const UPackageMod = await import("@unreal/un-package");
  const UPackage: any = (UPackageMod as any).default;

  UPackage.prototype.readArrayBuffer = async function (this: any) {
    const rel = this.path.replace(/^\/assets\//, "");
    const disk = nodePath.join(ROOT, supported[rel] ?? rel);
    const buf = fs.readFileSync(disk);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  /* decode-engine's initialize() fetches /asset-list.json */
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u.includes("asset-list.json"))
      return { json: async () => assetList, ok: true } as any;
    throw new Error(`unexpected fetch: ${u}`);
  };

  const { default: DecodeEngine } = await import(
    "@client/assets/decode-worker/decode-engine"
  );

  const settings: any = {
    cache: { enabled: false, version: 12 },
    decodeWorkerPoolSize: 0,
    textures: "rgba",
    batching: { terrain: true, staticMeshes: true },
  };

  const engine: any = new DecodeEngine();
  await engine.initialize();

  const meshName = process.argv[2] ?? "MFighter_m014_Hrh_ad01";
  const pkgName = process.argv[3] ?? "fighter";

  const t0 = performance.now();
  const library = await engine.decodeSkeletalMesh(
    settings,
    pkgName,
    meshName,
    null,
    [],
    null,
    true,
  );
  console.log(`decodeSkeletalMesh OK in ${(performance.now() - t0).toFixed(0)}ms`);
  console.log("library.name:", library.name);
  console.log("pawnActors:", library.pawnActors.length);
  const mesh = library.pawnActors[0];
  console.log("mesh keys:", Object.keys(mesh).join(", "));
  console.log("geometry:", mesh.geometry, "materials:", mesh.materials);
  console.log("bones:", mesh.bones?.length, "sections:", mesh.sections?.length);
  console.log("animationSequences:", mesh.animationSequences?.length);
  console.log("animations:", mesh.animations?.length);
  const geom = library.geometries[mesh.geometry];
  console.log("geometryInfo keys:", geom && Object.keys(geom).join(", "));
  if (geom) {
    console.log(
      "  vertices:",
      geom.vertices?.length,
      "indices:",
      geom.indices?.length,
      "normals:",
      geom.normals?.length,
      "uvs:",
      geom.uvs?.length,
      "colors:",
      geom.colors?.length,
      "bones:-",
      geom.bones?.length,
    );
  }
  console.log("materials in library:", Object.keys(library.materials).length);
  const mat = library.materials[mesh.materials];
  console.log("material:", mat && JSON.stringify(mat).slice(0, 400));
  const firstAnim = (mesh.animationSequences ?? [])[0];
  if (firstAnim) console.log("first anim key:", typeof firstAnim, String(firstAnim).slice(0, 120));
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
