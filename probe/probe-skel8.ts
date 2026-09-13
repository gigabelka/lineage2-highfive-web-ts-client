/* TEMPORARY probe v8 - full byte-level read trace of the SkeletalMesh doLoad */
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
    const buf = fs.readFileSync(nodePath.join(ROOT, supported[rel] ?? rel));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u.includes("asset-list.json"))
      return { json: async () => assetList, ok: true } as any;
    throw new Error(`unexpected fetch: ${u}`);
  };

  const { UObject } = await import("@l2js/core");

  (globalThis as any).console.assert = function (c: any, t: string) {
    if (!c) console.log(`   !! ASSERT: ${t}`);
  };

  const LO = Number(process.env.TRACE_LO ?? 14790250);
  const HI = Number(process.env.TRACE_HI ?? 14791420);
  const records: string[] = [];
  let recording = false;

  const origRead = UPackage.prototype.read;
  UPackage.prototype.read = function (this: any, target: any) {
    const before = this.offset;
    recording = before >= LO && before < HI;
    const r = origRead.call(this, target);
    if (recording) {
      const t =
        typeof target === "string"
          ? target
          : (target?.constructor?.name ?? String(typeof target));
      let v: any = r;
      if (typeof target === "string") v = r;
      else if (target && "value" in target) v = target.value;
      else v = `[${t}]`;
      records.push(`${before}\tread(${t})\t-> ${this.offset}\t= ${String(v).slice(0, 40)}`);
    }
    return r;
  };

  /* attribute each read to the currently executing frame is hard; instead tag loads */
  const origUObjectLoad = UObject.prototype.load;
  const frames: string[] = [];
  (UObject.prototype as any).load = function (this: any, pkg: any, info?: any) {
    const nm = this.constructor?.name ?? "?";
    if (/Vector|Quat|Rotator|Color|Bone|Joint|Skin|Wedge|Triangle|Vertex|Anim/.test(nm)) {
      const before = pkg.offset;
      frames.push(`${" ".repeat(0)}>>> ${nm}.load @${before}`);
      const r = origUObjectLoad.call(this, pkg, info);
      frames.push(`<<< ${nm}.load @${before} -> ${pkg.offset}`);
      return r;
    }
    return origUObjectLoad.call(this, pkg, info);
  };

  const { default: DecodeEngine } = await import(
    "@client/assets/decode-worker/decode-engine"
  );
  const settings: any = { cache: { enabled: false, version: 12 } };
  const engine: any = new DecodeEngine();
  await engine.initialize();

  const meshName = process.argv[2] ?? "MFighter_m014_Hrh_ad01";
  const pkgName = process.argv[3] ?? "fighter";

  await engine
    .decodeSkeletalMesh(settings, pkgName, meshName, null, [], null, false)
    .then(() => console.log("decodeSkeletalMesh OK"))
    .catch((e: any) => console.log("PROBE FAILED:", e.message));

  console.log(`\n=== read trace ${LO}..${HI} (${records.length} reads) ===`);
  console.log(records.join("\n"));
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message);
  process.exit(0);
});
