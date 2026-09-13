/* TEMPORARY probe harness v3 - the .ukx side */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

async function main() {
  const pkgPath = process.argv[2] ?? "animations/fighter.ukx";

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

  const pkg = await loader.using(loader.getPackage(pkgPath.replace(/\.[a-z]+$/, ""), "Animation"));

  console.log(`########## ${pkgPath} ##########`);
  console.log("exports:", pkg.exports.length, "imports:", pkg.imports.length);
  console.log("exportGroups keys:", Object.keys(pkg.exportGroups).sort().join(", "));

  for (const group of Object.keys(pkg.exportGroups).sort()) {
    if (!/mesh|anim|skeletal|lod/i.test(group)) continue;
    const list = pkg.exportGroups[group];
    console.log(`\n=== group '${group}' (${list.length}) ===`);
    for (const e of list.slice(0, 12)) {
      const exp = e.export;
      let clsRef = "?";
      if (exp.idClass === 0) clsRef = "<idClass=0>";
      else if (exp.idClass < 0) {
        const imp = pkg.imports[-exp.idClass - 1];
        clsRef = imp
          ? `imp#{obj=${imp.objectName}, cls=${imp.className}, clsPkg=${imp.classPackage}, idPkg=${imp.idPackage}}`
          : "?";
      } else clsRef = `exp#${exp.idClass - 1} ${pkg.exports[exp.idClass - 1]?.objectName}`;
      console.log(`  idx=${exp.index}\tname=${exp.objectName}\tidClass=${exp.idClass}\t${clsRef}\tidSuper=${exp.idSuper}\tsize=${exp.size}`);
    }
    if (list.length > 12) console.log(`  ... ${list.length - 12} more`);
  }

  console.log("\n=== imports ===");
  for (const imp of pkg.imports.slice(0, 40))
    console.log(
      `idx=${imp.index}\tobj=${imp.objectName}\tcls=${imp.className}\tclsPkg=${imp.classPackage}\tidPkg=${imp.idPackage}(${imp.idPackage < 0 ? pkg.imports[-imp.idPackage - 1]?.objectName : ""})`,
    );

  console.log("\n=== resolving the class of the first SkeletalMesh-group export ===");
  const grp = pkg.exportGroups["SkeletalMesh"] ?? pkg.exportGroups["Mesh"];
  if (grp?.[0]) {
    const exp = grp[0].export;
    try {
      const cls = pkg.fetchObject(exp.idClass);
      console.log("OK class:", cls?.constructor?.name, "friendlyName:", cls?.friendlyName, "inheritenceChain:", cls?.inheritenceChain);
    } catch (e) {
      console.log("THROW:", (e as Error).message);
    }
    try {
      const obj = pkg.fetchObject(exp.index + 1);
      console.log("OK object:", obj?.constructor?.name);
    } catch (e) {
      console.log("object THROW:", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
