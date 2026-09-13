# Build system and tooling

## Vite is the single source of truth

The project was migrated off Webpack. [vite.config.ts](../vite.config.ts) is the only build
config (`configs/` is the removed Webpack dir, still present but ignored). Notable settings:

- `root` = repo dir · `publicDir` = `html/` (served at `/`) · `build.outDir` = `bin/`
  (`emptyOutDir`, `sourcemap`, `target: "chrome80"`).
- `server`: port `8888`, host `127.0.0.1`. HMR is disabled when `LIVE_RELOAD=0`.
  `server.fs.allow: [ROOT]` (vendored `@l2js/core`/`gmp-wasm` live under the repo root, so no
  extra `node_modules` allow-listing is needed any more).
- `define: { global: "globalThis" }` — the source has runtime `global` refs; there is no
  Webpack node polyfill any more.
- `worker.format: "es"`.
- `optimizeDeps.exclude: ["@l2js/core"]` — consumed as raw TS source.
- `css.preprocessorOptions.scss.api: "modern"`.
- `envPrefix: ["VITE_", "L2_"]` — lets `src/net/config.ts` read live-server credentials from a
  git-ignored `.env` (see [.env.example](../.env.example) and
  [networking.md](networking.md#configuration)). Dev-only by construction: the network session
  additionally requires `import.meta.env.DEV`.
- Aliases: `@dimforge/rapier3d` → `@dimforge/rapier3d-compat`; `path` → `path-browserify`;
  `@l2js/core` → `vendor/l2js-core/src` (vendored raw source, **not** an npm/SSH dependency);
  `gmp-wasm` → `vendor/gmp-wasm/dist` (vendored prebuilt ESM bundle); plus the shared alias map
  (see below).

### The four custom plugins

| Plugin | What it does |
| --- | --- |
| `assetListPlugin` | Walks `c:/Games/HighFive/` on config-resolve (dev) and `buildStart` (build) and writes `html/asset-list.json` — a `supported` / `unsupported` / `music` map of every asset. Git-ignored, auto-generated, **never edit by hand**. |
| `rawShadersPlugin` | `.vs` / `.fs` / `.glsl` imports (no `?raw` suffix) resolve to the file text as a default-exported string. Replaces `raw-loader`. See [materials.md](materials.md#raw-shader-imports-rawshadersplugin). |
| `devServerPlugin` | Byte-range-aware static serving of `c:/Games/HighFive/` under `/assets`, plus a `POST /sector-test/report` sink that appends JSON lines to `sector-test-report.jsonl`. |
| `tcpBridgePlugin` ([tools/tcp-bridge-plugin.ts](../tools/tcp-bridge-plugin.ts)) | Dev-only (`apply: "serve"`, absent from `vite build`). Splices a WebSocket at `/l2-tcp?host=..&port=..` onto a real `net.Socket`, so the browser can reach a login/game server's TCP port. RFC1918/loopback + configured-`L2_LOGIN_IP` allowlist. See [networking.md](networking.md#the-browser-cannot-open-a-tcp-socket--the-dev-server-bridge). |

The old `l2CoreCjsShimPlugin` (CJS→ESM rewrite for `@l2js/core`'s one hand-authored CommonJS
file) is gone: vendoring rewrote `supported-extensions.js` to plain ESM/TS once, in place.

## npm scripts

| Script | Command | Purpose | Fails build? |
| --- | --- | --- | --- |
| `dev` | `vite` | Dev server on `127.0.0.1:8888`. HMR on unless `LIVE_RELOAD=0`. | — |
| `build-dev` | `vite build --mode development` | Build into `bin/` with sourcemaps. | yes (on real errors) |
| `preview` | `vite preview` | Serve a prior `bin/` build. | — |
| `test` | `vitest run` | Run the Vitest suite once. | yes |
| `test:watch` / `test:ui` | `vitest` / `vitest --ui` | Interactive runner. | — |
| `lint` / `lint:fix` | `eslint .` | ESLint v10 flat config. **Advisory** — not wired into build or test. | no |
| `typecheck` | `tsx tools/typecheck.ts` | `tsc --noEmit`, exit code only from `src/` errors. **Advisory.** | no |
| `knip` | `knip` | Report unused files / exports / deps. **Advisory.** | no |

## `tsconfig.json` quirks

- **`emitDeclarationOnly: true`** — types are never emitted to JS; esbuild / Vite strips
  them. **Type errors do not fail the build or the tests.**
- `useDefineForClassFields: false` — matches the old Babel `loose` class-fields semantics,
  which the UE2 class ports depend on.
- `moduleResolution: "bundler"`, `target` / `module` `ESNext`, `isolatedModules`.
- `noImplicitAny` / `noImplicitReturns` / `noImplicitThis` / `noFallthroughCasesInSwitch`
  on; `noUnusedLocals` / `noUnusedParameters` off (left to ESLint as `warn`).
- `paths` mirror the Vite aliases.

`@l2js/core` is imported as source, so `tsc` type-checks it too and it emits ~30 errors
unrelated to this project. [tools/typecheck.ts](../tools/typecheck.ts) runs `tsc`, prints
everything, but derives the exit code **only** from `error TS…` lines whose path is not under
`node_modules/`. It prints a Russian summary line.

## ESLint / knip are advisory

ESLint flat config ([eslint.config.mjs](../eslint.config.mjs)): `js.recommended` +
`typescript-eslint` recommended (no type-aware rules). Ignores `bin/ configs/ reference/
docs/ html/ *.d.ts *-report.jsonl`. Stylistic noise on the intentionally "dirty"
reverse-engineering code is downgraded to `warn` (`no-explicit-any`, `no-unused-vars`,
`no-empty-function`, `no-this-alias`, `ban-ts-comment`, `no-namespace`,
`no-duplicate-enum-values` — UE2 flag enums reuse bit values — etc.). Only rules that flag
real defects stay errors: assignment in condition, unreachable code, duplicate keys, `case`
fall-through.

`knip` ([knip.json](../knip.json)) lists the entry points (client graph, decode worker,
`?sectorTest` / `?precacheSectors`, configs, `tools/`). Expect false positives on the
`export { X }` next to `export default X` pattern and on classes registered only via the
`un-package.ts` import hub.

## Path aliases — defined in three places

Keep these in sync across [vite.config.ts](../vite.config.ts) (`resolve.alias`),
[tsconfig.json](../tsconfig.json) (`compilerOptions.paths`), and
[vitest.config.ts](../vitest.config.ts) (`resolve.alias`).

| Alias | Target |
| --- | --- |
| `@client/*` | `src/*` |
| `@unreal/*` | `src/assets/unreal/*` |
| `@native` | `src/assets/unreal/scripts/un-native-registry.ts` |
| `@l2js/core` | `vendor/l2js-core/src` (vendored raw source, upstream `realratchet/l2js-core`) |
| `gmp-wasm` | `vendor/gmp-wasm/dist` (vendored prebuilt ESM, WASM embedded as base64) |

VSCode is configured for non-relative imports
(`typescript.preferences.importModuleSpecifier: non-relative`) — prefer alias imports over
`../../..`.

## Runtime requirements

- **`c:/Games/HighFive/` must exist** — the real client asset install. `assetListPlugin`
  walks it and writes `html/asset-list.json`. Without assets the build still runs but the app
  has nothing to load.
- **`@l2js/core`** is **vendored** at `vendor/l2js-core/` (raw TS source) — no npm/SSH
  dependency; `npm install` needs no GitHub SSH access. Its `gmp-wasm` runtime dep is likewise
  vendored at `vendor/gmp-wasm/`. Edit `vendor/l2js-core/**` in place when core needs changes.
- `html/` (Vite `publicDir`, served at `/`) holds committed static assets (`skybox.png`)
  plus the generated `asset-list.json` (git-ignored). `bin/` is the build output, git-ignored.
- **`.env`** (git-ignored, copy from [.env.example](../.env.example)) — optional; only needed
  for the live-server networking session. See [networking.md](networking.md#configuration).

## `tools/`

- [tools/typecheck.ts](../tools/typecheck.ts) — the advisory `tsc` wrapper described above.
- [tools/tcp-bridge-plugin.ts](../tools/tcp-bridge-plugin.ts) — the dev-only WebSocket↔TCP
  bridge plugin (see above and [networking.md](networking.md)).
