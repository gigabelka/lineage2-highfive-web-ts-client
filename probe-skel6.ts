/* TEMPORARY probe harness v6 - bytes + per-load trace around the desync */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

function hex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

async function main() {
  const UPackageMod = await import("@unreal/un-package");
  const UPackage: any = (UPackageMod as any).default;
  (globalThis as any).__upkg = UPackage;

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

  const { UObject } = await import("@l2js/core");
  const arrayMod: any = await import("@l2js/core/unreal/un-array");

  (globalThis as any).console.assert = function (cond: any, text: string) {
    if (!cond) console.log(`   !! ASSERT FAILED: ${text}`);
  };

  /* record the last N loads with their byte spans */
  const trace: string[] = [];
  const origLoad = UObject.prototype.load;
  (UObject.prototype as any).load = function (this: any, pkg: any, info?: any) {
    const before = pkg.tell();
    const r = origLoad.call(this, pkg, info);
    const name = this.constructor?.name ?? "?";
    if (!/Vector|Quat|Rotator|Color|AnimMeshVertex|SkinVertexStream|JointPos/.test(name)) return r;
    trace.push(`${name} @${before} -> ${pkg.tell()} (${pkg.tell() - before}B)`);
    if (trace.length > 120) trace.shift();
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

  let failed = false;
  const library = await engine
    .decodeSkeletalMesh(settings, pkgName, meshName, null, [], null, false)
    .catch((e: any) => {
      failed = true;
      console.log("PROBE FAILED:", e.message);
      return null;
    });

  console.log("--- last loads ---");
  console.log(trace.slice(-40).join("\n"));

  if (failed) {
    /* find the package and dump raw bytes around the desync */
    const loader = (engine as any).assetLoader;
    const pkg: any = loader.getPackage("fighter", "Animation");
    const at = Number(process.argv[4] ?? 14791312);
    pkg.seek(at - 32, "set");
    const view: any = pkg.read(128);
    console.log(`\nraw @${at - 32}:`, hex(new Uint8Array(view.buffer ?? view)));
    return;
  }
  console.log("decodeSkeletalMesh OK");
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message, e.stack?.split("\n").slice(1, 5).join("\n"));
  process.exit(0);
});
