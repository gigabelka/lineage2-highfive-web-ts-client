/* TEMPORARY probe harness (delete after the investigation).
   Runs the REAL decode pipeline in Node by overriding UPackage.readArrayBuffer to
   read from disk instead of OPFS. */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

function dumpExports(pkg: any, filter?: RegExp) {
  const rows: any[] = [];
  for (const exp of pkg.exports) {
    const name = exp.objectName as string;
    if (filter && !filter.test(name)) continue;
    let cls = "?";
    let sup = "?";
    try {
      cls = exp.idClass === 0 ? "<self>" : `${pkg.getPackageName(exp.idClass)}`;
    } catch (e) {
      cls = "err";
    }
    try {
      sup = exp.idSuper === 0 ? "<none>" : `${pkg.getPackageName(exp.idSuper)}`;
    } catch (e) {
      sup = "err";
    }
    rows.push({ i: exp.index, name, cls, sup, idClass: exp.idClass, idSuper: exp.idSuper, flags: exp.flags, size: exp.size });
  }
  return rows;
}

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
  (globalThis as any).__probe = { loader, supported, dumpExports };

  console.log("########## ENGINE.U ##########");
  const engine = loader.getEnginePackage();
  await loader.load(engine);
  console.log("exports total:", engine.exports.length);
  console.log("exportGroups keys:", Object.keys(engine.exportGroups).sort().join(", "));

  console.log("---- /mesh/i ----");
  console.table(dumpExports(engine, /mesh/i).map((r) => ({ i: r.i, name: r.name, cls: r.cls, sup: r.sup, size: r.size })));

  console.log("---- ALL engine exports ----");
  const all = dumpExports(engine).map((r) => ({ i: r.i, name: r.name, cls: r.cls, sup: r.sup, size: r.size }));
  console.log("count:", all.length);
  fs.writeFileSync("probe-engine-exports.json", JSON.stringify(all, null, 1));
  console.log(all.map((r) => `${r.i}\t${r.name}\t${r.cls}\t${r.sup}\t${r.size}`).join("\n"));
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
