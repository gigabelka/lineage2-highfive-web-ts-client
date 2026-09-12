/* TEMPORARY probe - inspect imports of the `fighter` package (characterHairPieces path) */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

async function main() {
  const UPackageMod = await import("@unreal/un-package");
  UPackageMod.default.prototype.readArrayBuffer = async function (this: any) {
    const p = this.path.replace(/^\/assets\//, "");
    const b = fs.readFileSync(nodePath.join(ROOT, supported[p] ?? p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u.includes("asset-list.json")) return { json: async () => assetList, ok: true } as any;
    throw new Error(`unexpected fetch: ${u}`);
  };

  const { default: DecodeEngine } = await import("@client/assets/decode-worker/decode-engine");
  const settings: any = { cache: { enabled: false, version: 12 } };
  const engine: any = new DecodeEngine();
  await engine.initialize();

  const loader: any = (engine as any).assetLoader;
  const pkgName = process.argv[2] ?? "MFighter";
  const pkgs: any = (loader as any).packages;
  const hits: any[] = [];
  for (const [base, byExt] of pkgs.entries()) {
    for (const [ext, p] of byExt.entries()) {
      if (String(base).toLowerCase().includes(pkgName.toLowerCase())) hits.push([base, ext, p]);
    }
  }
  console.log(`registered packages matching "${pkgName}":`);
  for (const [base, ext, p] of hits) console.log(`   ${base} [${ext}] -> ${p.path}`);
  const handle: any = hits.length ? hits[0][2] : loader.getPackage(pkgName, "Animation");
  const pkg: any = await handle.asReadable().decode();

  console.log(`${pkgName}: ${pkg.imports?.length} imports, ${pkg.exports?.length} exports`);
  console.log(`\nimports with idPackage === 0:`);
  for (const [i, imp] of pkg.imports.entries()) {
    if (imp.idPackage !== 0) continue;
    console.log(`  [-${i + 1}] objectName="${imp.objectName}" className="${imp.className}" idPackage=${imp.idPackage}`);
  }

  /* the walk core's AAssetLoader.load does: follow idPackage to the root package name */
  const rootPackageOf = (imp: any): string => {
    if (imp.idPackage === 0) return "<idPackage 0>";
    let ep = pkg.getImportEntry(imp.idPackage);
    if (!ep) return "<null parent>";
    while (ep.idPackage !== 0) {
      const next = pkg.getImportEntry(ep.idPackage);
      if (!next) return `<null in chain after "${ep.objectName}">`;
      ep = next;
    }
    return ep.objectName;
  };

  console.log(`\nnon-Package imports with idPackage === 0:`);
  for (const [i, imp] of pkg.imports.entries()) {
    if (imp.idPackage !== 0 || imp.className === "Package") continue;
    console.log(`  [-${i + 1}] objectName="${imp.objectName}" className="${imp.className}"`);
  }

  console.log(`\nSkeletalMesh imports and their resolved root package:`);
  let n = 0;
  for (const [i, imp] of pkg.imports.entries()) {
    if (imp.className !== "SkeletalMesh") continue;
    console.log(`  [-${i + 1}] "${imp.objectName}" -> root="${rootPackageOf(imp)}"`);
    if (++n >= 8) break;
  }

  console.log(`\nany import resolving to root "Class":`);
  for (const [i, imp] of pkg.imports.entries()) {
    const root = rootPackageOf(imp);
    if (root === "Class") {
      const pp = imp.idPackage !== 0 ? pkg.getImportEntry(imp.idPackage) : null;
      console.log(
        `  [-${i + 1}] "${imp.objectName}" className="${imp.className}" idPackage=${imp.idPackage} parent="${pp?.objectName}(class=${pp?.className})"`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message, (e.stack ?? "").split("\n").slice(0, 6).join("\n"));
  process.exit(0);
});
