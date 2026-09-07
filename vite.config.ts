import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

const ROOT = __dirname;
const DIR_ASSETS = path.resolve("c:/Games/HighFive");
const PUBLIC_DIR = path.resolve(ROOT, "html");
const ASSET_LIST_FILE = path.resolve(PUBLIC_DIR, "asset-list.json");
const SECTOR_REPORT_FILE = path.resolve(ROOT, "sector-test-report.jsonl");

const SUPPORTED_EXTENSIONS = ["UNR", "UTX", "USX", "UAX", "U", "UKX", "USK"];

function* walkSync(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkSync(full);
        else yield full;
    }
}

/**
 * Regenerates `html/asset-list.json` (git-ignored, auto-generated) by walking
 * the assets root (`c:/Games/HighFive`). Was `configs/create-config.js`'s build-time step; now runs on
 * config resolve (dev) and buildStart (build). `html/` is the Vite publicDir, so
 * the file is served at `/asset-list.json` in dev and copied into `bin/` on build.
 */
function assetListPlugin(): Plugin {
    const generate = () => {
        if (!fs.existsSync(DIR_ASSETS)) {
            console.warn(`[asset-list] ${DIR_ASSETS} missing - writing empty asset-list.json`);
        }

        const fileList = {
            comment: "This file is auto-generated, any changes will be lost.",
            supported: {} as Record<string, string>,
            unsupported: [] as string[],
            /* loose .ogg music tracks - not UE2 packages, fetched directly by AudioManager */
            music: {} as Record<string, string>
        };

        for (const fname of walkSync(DIR_ASSETS)) {
            const ext = path.extname(fname).slice(1).toUpperCase();
            /* the pipeline expects POSIX paths relative to the assets root */
            const relPath = path.relative(DIR_ASSETS, fname).split(path.sep).join("/");

            if (ext === "OGG") {
                fileList.music[path.basename(fname).toLowerCase()] = `assets/${relPath}`;
                continue;
            }

            if (!SUPPORTED_EXTENSIONS.includes(ext)) {
                fileList.unsupported.push(relPath);
                continue;
            }

            fileList.supported[relPath.toLowerCase()] = relPath;
        }

        fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        fs.writeFileSync(ASSET_LIST_FILE, JSON.stringify(fileList, undefined, 4));
    };

    return {
        name: "l2-asset-list",
        configResolved: generate,
        buildStart: generate
    };
}

/**
 * Replaces `raw-loader`: `.vs`/`.fs`/`.glsl` imports resolve to the file's text as
 * a default-exported string. Imports in src/materials/** and register-chunks.ts
 * carry no `?raw` suffix, so a plugin is needed rather than Vite's built-in.
 */
function rawShadersPlugin(): Plugin {
    const RE = /\.(vs|fs|glsl)$/;
    return {
        name: "l2-raw-shaders",
        transform(src, id) {
            if (!RE.test(id.split("?")[0])) return null;
            return { code: `export default ${JSON.stringify(src)};`, map: null };
        }
    };
}

/** Byte-range aware static serving of the assets root under /assets, plus the
 *  ?sectorTest report sink. Ported from configs/create-config.js + chunker-middleware.js. */
function devServerPlugin(): Plugin {
    return {
        name: "l2-dev-server",
        configureServer(server) {
            server.middlewares.use("/assets", (req, res, next) => {
                if (req.method !== "GET" && req.method !== "HEAD") return next();

                const relPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
                const filePath = path.join(DIR_ASSETS, relPath);

                if (!filePath.startsWith(DIR_ASSETS)) return next();

                let stats: fs.Stats;
                try {
                    stats = fs.statSync(filePath);
                } catch {
                    return next();
                }
                if (!stats.isFile()) return next();

                const fileSize = stats.size;
                const range = req.headers.range;
                let start = 0;
                let end = fileSize - 1;
                let isRange = false;

                if (range) {
                    const [s, e] = range.replace(/bytes=/, "").split("-");
                    if (s !== "") {
                        start = parseInt(s, 10);
                        if (e !== "") end = parseInt(e, 10);
                    } else if (e !== "") {
                        start = fileSize - parseInt(e, 10);
                    }
                    isRange = true;
                }

                if (start < 0) start = 0;
                if (end >= fileSize) end = fileSize - 1;

                if (start > end) {
                    res.statusCode = 416;
                    res.setHeader("Content-Range", `bytes */${fileSize}`);
                    res.end();
                    return;
                }

                res.setHeader("Accept-Ranges", "bytes");
                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader("Cache-Control", "public, max-age=0");

                if (isRange) {
                    res.statusCode = 206;
                    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
                    res.setHeader("Content-Length", end - start + 1);
                } else {
                    res.statusCode = 200;
                    res.setHeader("Content-Length", fileSize);
                }

                if (req.method === "HEAD") {
                    res.end();
                    return;
                }

                fs.createReadStream(filePath, { start, end }).pipe(res);
            });

            server.middlewares.use("/sector-test/report", (req, res, next) => {
                if (req.method !== "POST") return next();

                const chunks: Buffer[] = [];
                req.on("data", c => chunks.push(c as Buffer));
                req.on("end", () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                        fs.appendFileSync(SECTOR_REPORT_FILE, JSON.stringify({ t: new Date().toISOString(), ...body }) + "\n");
                        res.statusCode = 204;
                    } catch (e) {
                        res.statusCode = 400;
                        res.end(String(e));
                        return;
                    }
                    res.end();
                });
            });
        }
    };
}

export default defineConfig({
    root: ROOT,
    publicDir: PUBLIC_DIR,
    define: {
        // webpack's node.global polyfill is gone - src/ has runtime `global` refs
        global: "globalThis"
    },
    resolve: {
        // keep in sync with tsconfig.json "paths"
        alias: [
            { find: "@native", replacement: path.resolve(ROOT, "src/assets/unreal/scripts/un-native-registry.ts") },
            { find: /^@client\/(.*)$/, replacement: path.resolve(ROOT, "src") + "/$1" },
            { find: /^@unreal\/(.*)$/, replacement: path.resolve(ROOT, "src/assets/unreal") + "/$1" },
            { find: /^@l2js\/core$/, replacement: path.resolve(ROOT, "vendor/l2js-core/src/index.ts") },
            // some source files import "@l2js/core/src/…", others "@l2js/core/…" - collapse the optional "src/"
            { find: /^@l2js\/core\/(?:src\/)?(.*)$/, replacement: path.resolve(ROOT, "vendor/l2js-core/src") + "/$1" },
            // gmp-wasm is vendored (prebuilt ESM, WASM embedded) so the @l2js/core RSA-decrypt path has no npm dependency
            { find: /^gmp-wasm$/, replacement: path.resolve(ROOT, "vendor/gmp-wasm/dist/index.esm.min.js") },
            { find: /^@dimforge\/rapier3d$/, replacement: "@dimforge/rapier3d-compat" },
            { find: /^path$/, replacement: "path-browserify" }
        ]
    },
    // Dart Sass's modern API is the only one left (the legacy JS API was removed
    // in Dart Sass 2.0) and Vite 8 uses it unconditionally, so no `css.preprocessorOptions` needed.
    worker: {
        format: "es"
    },
    server: {
        port: 8888,
        host: "127.0.0.1",
        // LIVE_RELOAD=0 for automated ?sectorTest sweeps - a mid-sweep reload corrupts the report
        hmr: process.env.LIVE_RELOAD === "0" ? false : undefined,
        fs: {
            allow: [ROOT]
        }
    },
    build: {
        outDir: "bin",
        emptyOutDir: true,
        target: "chrome80",
        sourcemap: true
    },
    plugins: [assetListPlugin(), rawShadersPlugin(), devServerPlugin()]
});
