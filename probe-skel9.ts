/* TEMPORARY probe harness v9 - load just the two known-failing SkeletalMesh exports directly,
   bypassing DecodeEngine/character-bundle assembly, to test the FStaticModelLOD fix fast. */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

async function main() {
  const t0 = performance.now();
  const UPackageMod = await import("@unreal/un-package");
  const UPackage: any = (UPackageMod as any).default;

  UPackage.prototype.readArrayBuffer = async function (this: any) {
    const rel = this.path.replace(/^\/assets\//, "");
    const disk = nodePath.join(ROOT, supported[rel] ?? rel);
    const buf = fs.readFileSync(disk);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  const AssetLoader: any = (await import("@client/assets/asset-loader")).default;
  const loader = await AssetLoader.Instantiate(supported);

  await loader.using(loader.getNativePackage(), { neverUnload: true });
  const pkgCore = await loader.using(loader.getCorePackage(), { neverUnload: true });

  await loader.using(loader.getEnginePackage(), { neverUnload: true });
  pkgCore.loadNativeClasses();

  console.log(`loader ready in ${(performance.now() - t0).toFixed(0)}ms`);

  const t1 = performance.now();
  const pkg = await loader.using(loader.getPackage("animations/fighter.ukx"));

  console.log(`fighter.ukx opened in ${(performance.now() - t1).toFixed(0)}ms, exports=${pkg.exports.length}`);

  const names = process.argv.slice(2);
  const targets = names.length ? names : ["MFighter_m001_g", "MFighter_m001_u", "MFighter_m000_f", "FFighter_m000_f"];

  for (const name of targets) {
    const exp = pkg.exports.find((e: any) => e.objectName === name);

    if (!exp) {
      console.log(`${name}: not found in export table`);
      continue;
    }

    const t2 = performance.now();

    try {
      const obj = pkg.fetchObject(exp.index + 1);

      obj.loadSelf();
      console.log(
        `${name}: OK in ${(performance.now() - t2).toFixed(0)}ms - lodModels=${obj.lodModels?.length}, ` +
          `lod0 sections soft=${obj.lodModels?.[0]?.softSections?.length} rigid=${obj.lodModels?.[0]?.rigidSections?.length}, ` +
          `softIndices=${obj.lodModels?.[0]?.softIndices?.indices?.getElemCount?.()}, ` +
          `rigidIndices=${obj.lodModels?.[0]?.rigidIndices?.indices?.getElemCount?.()}, ` +
          `streamVerts=${obj.lodModels?.[0]?.skinVertexStream?.vertices?.length}`,
      );
    } catch (e) {
      console.log(`${name}: THROW in ${(performance.now() - t2).toFixed(0)}ms - ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
