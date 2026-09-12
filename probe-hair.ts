/* TEMPORARY probe - reproduce characterHairPieces failure directly */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

/* tsx already defines `self` (= globalThis); only ADD `location` rather than replacing `self`,
   which corrupts tsx's own transform state. */
const g = globalThis as any;
if (typeof g.self === "undefined") g.self = g;
g.self.location = { origin: "http://localhost" };

/* serve every asset the browser would fetch straight off disk */
g.fetch = async (url: any) => {
  const u = new URL(String(url), "http://localhost");
  const p = decodeURIComponent(u.pathname);
  const body = (buf: any, type: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => type },
    arrayBuffer: async () => buf,
  });

  if (p.endsWith("asset-list.json")) {
    const enc = new TextEncoder().encode(JSON.stringify(assetList));
    return { ...body(enc.buffer, "text/plain"), json: async () => assetList };
  }

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

  const rows: any[] = await engine.decodeCharGrp();
  console.log(`chargrp rows: ${rows.length}`);
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    console.log(
      `  [${i}] face_mesh[0]="${rows[i].face_mesh?.[0]}" face_tex[0]="${rows[i].face_tex?.[0]}" body_mesh=[${(rows[i].body_mesh ?? []).join(" | ")}]`,
    );
  }

  const loader: any = engine.assetLoader;
  const origLoad = loader.load.bind(loader);
  let lastPkg = "?";
  loader.load = async (pkg: any) => {
    lastPkg = pkg?.path;
    try {
      return await origLoad(pkg);
    } catch (e: any) {
      console.log(`  !! load(${pkg?.path}) FAILED: ${e.message}`);
      throw e;
    }
  };

  const origHas = loader.hasPackage.bind(loader);
  loader.hasPackage = (name: string, type: string) => {
    const r = origHas(name, type);
    if (!r) console.log(`  !! hasPackage("${name}", "${type}") = false`);
    return r;
  };

  const origCHP = engine.characterHairPieces.bind(engine);
  engine.characterHairPieces = async (idx: number) => {
    console.log(`  -> decodeCharGroups calling characterHairPieces(${idx}) face_mesh[0]="${(await engine.decodeCharGrp())[idx]?.face_mesh?.[0]}"`);
    return origCHP(idx);
  };

  try {
    const groups = await engine.decodeCharGroups();
    console.log(`decodeCharGroups OK, ${groups.length} groups`);
  } catch (e: any) {
    console.log(`decodeCharGroups THREW: ${e.message}`);
    console.log((e.stack ?? "").split("\n").slice(1, 10).join("\n"));
  }

  for (let idx = 0; idx < rows.length; idx++) {
    try {
      const pieces = await engine.characterHairPieces(idx);
      console.log(`characterHairPieces(${idx}) OK -> ${JSON.stringify(pieces).slice(0, 200)}`);
    } catch (e: any) {
      console.log(`characterHairPieces(${idx}) THREW: ${e.message}`);
      console.log((e.stack ?? "").split("\n").slice(1, 10).join("\n"));
      break;
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.log("HARNESS FAILED:", e.message, (e.stack ?? "").split("\n").slice(0, 8).join("\n"));
  process.exit(0);
});
