/* TEMPORARY probe - locate the SkeletalMesh LOD misalignment */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

const g = globalThis as any;
if (typeof g.self === "undefined") g.self = g;
g.self.location = { origin: "http://localhost" };

g.fetch = async (url: any) => {
  const u = new URL(String(url), "http://localhost");
  const p = decodeURIComponent(u.pathname);
  const body = (buf: any, type: string) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { get: () => type },
    arrayBuffer: async () => buf,
  });
  if (p.endsWith("asset-list.json"))
    return { ...body(new TextEncoder().encode(JSON.stringify(assetList)).buffer, "text/plain"), json: async () => assetList };
  const rel = p.replace(/^\/assets\//, "");
  const disk = nodePath.join(ROOT, supported[rel] ?? rel);
  if (!fs.existsSync(disk)) throw new Error(`no such asset: ${p} (disk ${disk})`);
  const b = fs.readFileSync(disk);
  return body(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "application/octet-stream");
};

async function main() {
  const { default: DecodeEngine } = await import("@client/assets/decode-worker/decode-engine");
  const settings: any = { cache: { enabled: false, version: 12 } };
  const engine: any = new DecodeEngine();
  await engine.initialize();

  const meshName = process.argv[2] ?? "MFighter_m014_Hrh_ad01";
  const pkgName = process.argv[3] ?? "fighter";

  try {
    await engine.decodeSkeletalMesh(settings, pkgName, meshName, null, [], null, false);
    console.log("decodeSkeletalMesh OK");
  } catch (e: any) {
    console.log(`THREW: ${e.message}`);
    console.log((e.stack ?? "").split("\n").slice(1, 14).join("\n"));
  }
  process.exit(0);
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message, (e.stack ?? "").split("\n").slice(0, 8).join("\n"));
  process.exit(0);
});
