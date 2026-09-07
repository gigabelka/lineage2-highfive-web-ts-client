import { defineConfig } from "vitest/config";
import path from "node:path";

const ROOT = __dirname;

/**
 * Standalone Vitest config. Intentionally does NOT reuse `vite.config.ts` so the
 * custom dev-server plugins (`assetListPlugin`, `devServerPlugin`, raw shaders,
 * raw shaders) never run inside the test environment.
 *
 * The `resolve.alias` block below MUST stay in sync with `vite.config.ts`
 * (`resolve.alias`) and `tsconfig.json` (`compilerOptions.paths`).
 */
export default defineConfig({
    define: {
        global: "globalThis"
    },
    resolve: {
        alias: [
            { find: "@native", replacement: path.resolve(ROOT, "src/assets/unreal/scripts/un-native-registry.ts") },
            { find: /^@client\/(.*)$/, replacement: path.resolve(ROOT, "src") + "/$1" },
            { find: /^@unreal\/(.*)$/, replacement: path.resolve(ROOT, "src/assets/unreal") + "/$1" },
            { find: /^@l2js\/core$/, replacement: path.resolve(ROOT, "vendor/l2js-core/src/index.ts") },
            { find: /^@l2js\/core\/(?:src\/)?(.*)$/, replacement: path.resolve(ROOT, "vendor/l2js-core/src") + "/$1" },
            { find: /^@dimforge\/rapier3d$/, replacement: "@dimforge/rapier3d-compat" },
            { find: /^path$/, replacement: "path-browserify" }
        ]
    },
    test: {
        // Node by default; a render/DOM test opts in per-file with
        // `// @vitest-environment jsdom` at the top of the file.
        environment: "node",
        include: ["src/**/*.{test,spec}.ts"],
        // decode-worker code and UE2 parsing are heavy; give slow suites room
        testTimeout: 20000
    }
});
