/* TEMPORARY probe - find which package/import breaks AAssetLoader.load's dependency walk */
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

  const loader: any = engine.assetLoader;
  const pkgs: any = loader.packages;
  const all: any[] = [];
  for (const [, byExt] of pkgs.entries()) for (const [, p] of byExt.entries()) all.push(p);

  console.log(`registered packages: ${all.length}`);
  let broken = 0;
  let checked = 0;

  for (const pkg of all) {
    let view: any = pkg;
    try {
      if (!view.imports) view = await pkg.asReadable().decode();
    } catch (e: any) {
      console.log(`  (decode failed for ${pkg.path}: ${e.message})`);
      continue;
    }
    checked++;

    for (const [i, entry] of (view.imports ?? []).entries()) {
      if (entry.className === "Package") continue;
      if (entry.idPackage === 0) continue;

      let ep: any;
      try {
        ep = view.getImportEntry(entry.idPackage);
        while (ep && ep.idPackage !== 0) ep = view.getImportEntry(ep.idPackage);
      } catch (e: any) {
        console.log(`  !! ${pkg.path} [-${i + 1}] "${entry.objectName}" class=${entry.className} chain THREW: ${e.message}`);
        broken++;
        continue;
      }
      if (!ep) continue;

      const packageName = ep.objectName;
      if (!loader.hasPackage(packageName, entry.className)) {
        console.log(
          `  !! ${pkg.path} [-${i + 1}] "${entry.objectName}" class="${entry.className}" -> rootPackage="${packageName}" NOT FOUND`,
        );
        if (++broken > 40) { console.log("  ...stopping"); return; }
      }
    }
  }
  console.log(`checked ${checked} packages, ${broken} broken import refs`);
  process.exit(0);
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message, (e.stack ?? "").split("\n").slice(0, 8).join("\n"));
  process.exit(0);
});
