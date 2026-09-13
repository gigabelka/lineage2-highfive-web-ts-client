/* TEMPORARY probe harness v2 */
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

  const engine = loader.getEnginePackage();
  await loader.load(engine);

  console.log("engine exports:", engine.exports.length, "imports:", engine.imports.length);

  const describe = (pkg: any, exp: any) => {
    let cls = "";
    if (exp.idClass === 0) cls = "<idClass=0>";
    else if (exp.idClass < 0) {
      const imp = pkg.imports[-exp.idClass - 1];
      cls = imp ? `${imp.className}/${imp.classPackage}(obj=${imp.objectName})` : "?imp";
    } else cls = `export#${exp.idClass - 1}`;
    return cls;
  };

  console.log("\n=== ENGINE exports that look like UClass declarations (cls-import className === 'Class' or idClass === 0) ===");
  for (const exp of engine.exports) {
    let isCls = false;
    if (exp.idClass === 0) isCls = true;
    else if (exp.idClass < 0) {
      const imp = engine.imports[-exp.idClass - 1];
      if (imp && imp.className === "Class") isCls = true;
    }
    if (!isCls) continue;
    if (exp.isFake) continue;
    console.log(`${exp.index}\t${exp.objectName}\t${describe(engine, exp)}\tsize=${exp.size}\tflags=${exp.flags}`);
  }

  console.log("\n=== ENGINE fake (synthesized) exports, with raw refs ===");
  for (const exp of engine.exports.filter((e: any) => e.isFake)) {
    console.log(`${exp.index}\t${exp.objectName}\t${describe(engine, exp)}\tidClass=${exp.idClass}\tidSuper=${exp.idSuper}`);
  }

  console.log("\n=== ENGINE imports named like mesh classes ===");
  for (const imp of engine.imports) {
    if (/mesh|skeletal|lod/i.test(imp.objectName) || /Class/.test(imp.className))
      console.log(`idx=${imp.index}\tobj=${imp.objectName}\tcls=${imp.className}\tclsPkg=${imp.classPackage}\tidPkg=${imp.idPackage}\tisFake=${imp.isFake}`);
  }

  console.log("\n=== native package class exports ===");
  const native = loader.getNativePackage();
  await native.decode();
  for (const exp of native.exports)
    console.log(`${exp.index}\t${exp.objectName}\tidClass=${exp.idClass}\tidSuper=${exp.idSuper}\tisFake=${exp.isFake}`);

  (globalThis as any).__loader = loader;
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
