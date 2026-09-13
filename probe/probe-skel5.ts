/* TEMPORARY probe harness v5 - instrumented FArray / FArrayLazy trace */
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

  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u.includes("asset-list.json"))
      return { json: async () => assetList, ok: true } as any;
    throw new Error(`unexpected fetch: ${u}`);
  };

  const arrayMod: any = await import("@l2js/core/unreal/un-array");
  const FArray: any = arrayMod.default;
  const FArrayLazy: any = arrayMod.FArrayLazy;

  /* soft console.assert so we see every desync instead of the first throw */
  (globalThis as any).console.assert = function (cond: any, text: string) {
    if (!cond) console.log(`   !! ASSERT FAILED: ${text}`);
  };
  /* keep the real error channel visible */
  const realError = console.error.bind(console);
  void realError;

  const origArrayLoad = FArray.prototype.load;
  FArray.prototype.load = function (this: any, pkg: any, tag?: any) {
    const before = pkg.tell();
    const r = origArrayLoad.call(this, pkg, tag);
    if (this.constructor?.name === "FArrayLazy") return r;
    const name = this.Constructor?.name ?? "?";
    if (/Mesh|Bone|Skin|Triangle|Wedge|Vertex|Joint|Weight|Anim/.test(name))
      console.log(
        `   FArray<${name}> @${before} count=${this.length} -> end=${pkg.tell()}`,
      );
    return r;
  };

  const origLazyLoad = FArrayLazy.prototype.load;
  FArrayLazy.prototype.load = function (this: any, pkg: any, tag?: any) {
    const before = pkg.tell();
    const r = origLazyLoad.call(this, pkg, tag);
    console.log(
      `   FArrayLazy<${this.Constructor?.name}> @${before} lazyInt=${this.unkLazyInt} end=${pkg.tell()} delta=${pkg.tell() - this.unkLazyInt}`,
    );
    return r;
  };

  const { default: DecodeEngine } = await import(
    "@client/assets/decode-worker/decode-engine"
  );

  const settings: any = { cache: { enabled: false, version: 12 } };
  const engine: any = new DecodeEngine();
  await engine.initialize();

  const meshName = process.argv[2] ?? "MFighter_m014_Hrh_ad01";
  const pkgName = process.argv[3] ?? "fighter";

  const library = await engine.decodeSkeletalMesh(
    settings,
    pkgName,
    meshName,
    null,
    [],
    null,
    false, // no animations for this trace
  );
  console.log("decodeSkeletalMesh OK");
  console.log("mesh keys:", Object.keys(library.pawnActors[0]).join(", "));
}

main().catch((e) => {
  console.log("PROBE FAILED:", e.message);
  console.log(e.stack?.split("\n").slice(1, 6).join("\n"));
  process.exit(0);
});
