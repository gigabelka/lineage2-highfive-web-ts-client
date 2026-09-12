/* TEMPORARY probe harness v10 - decode every SkeletalMesh export in a package, tally ok/fail. */
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

  const AssetLoader: any = (await import("@client/assets/asset-loader")).default;
  const loader = await AssetLoader.Instantiate(supported);

  await loader.using(loader.getNativePackage(), { neverUnload: true });
  const pkgCore = await loader.using(loader.getCorePackage(), { neverUnload: true });

  await loader.using(loader.getEnginePackage(), { neverUnload: true });
  pkgCore.loadNativeClasses();

  const pkgPath = process.argv[2] ?? "animations/fighter.ukx";
  const pkg = await loader.using(loader.getPackage(pkgPath));

  const meshExports = pkg.exports.filter((e: any) => e.className === "SkeletalMesh" || pkg.imports[-e.idClass - 1]?.objectName === "SkeletalMesh");

  console.log(`${pkgPath}: ${meshExports.length} SkeletalMesh export(s)`);

  let ok = 0, fail = 0;
  const failures: string[] = [];

  const origWarn = console.warn;
  console.warn = () => {}; // silence the "keeping N LOD(s)" notices for this sweep

  for (const exp of meshExports) {
    try {
      const obj = pkg.fetchObject(exp.index + 1);

      obj.loadSelf();
      ok++;
    } catch (e) {
      fail++;
      failures.push(`${exp.objectName}: ${(e as Error).message}`);
    }
  }

  console.warn = origWarn;

  console.log(`ok=${ok} fail=${fail}`);
  for (const f of failures.slice(0, 30)) console.log("  FAIL:", f);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
