# Testing

## Vitest

- Config: [vitest.config.ts](../vitest.config.ts) — **standalone**. It deliberately does not
  import `vite.config.ts`, so none of the four dev-server plugins (including
  `rawShadersPlugin` and the `@l2js/core` CJS shim) run under test.
- It duplicates the `resolve.alias` map and `define: { global: "globalThis" }` — keep those
  in sync with `vite.config.ts` and `tsconfig.json`.
- `test.environment: "node"`; a file opts into jsdom with `// @vitest-environment jsdom`.
- `test.include: ["src/**/*.{test,spec}.ts"]`, `test.testTimeout: 20000` (UE2 parsing is
  heavy).
- Type errors do not fail tests (`tsconfig.json` is `emitDeclarationOnly`).

### Current coverage

Thin outside `src/net/**`. [src/__smoke__/sanity.test.ts](../src/__smoke__/sanity.test.ts) is a
smoke test that proves the runner, the TS transform, and alias resolution work. **Keep
`npm test` green** so the `tdd` skill has a baseline. Add tests alongside the code you change. A
test that imports a material module must stub the raw shader imports itself (see above).

`src/net/**` (the live-server networking layer, see [networking.md](networking.md)) is the one
part of the codebase with real unit coverage, because it has no three.js/DOM/UE2-binary
dependency: [packet-codec.spec.ts](../src/net/binary/packet-codec.spec.ts) (reader/writer
round-trips), [crypto.spec.ts](../src/net/crypto/crypto.spec.ts) (Blowfish/login-crypt/
game-crypt/RSA round-trips), [parsers.spec.ts](../src/net/parsers/parsers.spec.ts) (packet body
parsers), [world-tile.spec.ts](../src/net/world-tile.spec.ts) (coord→sector-id mapping),
[ws-transport.spec.ts](../src/net/ws-transport.spec.ts) (`FrameReassembler` framing). Treat this
as the pattern to follow when a new piece of `src/net/**` needs coverage — there is no
`?sectorTest`-style integration harness for the network stack; testing the full handshake
end-to-end means running `npm run dev` against a real login/game server.

## `?sectorTest` — the full-map sweep harness

[src/sector-test.ts](../src/sector-test.ts). This is the closest thing to a full integration
test. It decodes every level sector through the worker, instantiates it, renders + simulates
6 frames in an offscreen `WebGLRenderer` (shader compile, emitter warmup, lighting, animated
materials), probes luminance and terrain colour, and POSTs one JSONL row per sector.

Run it: open `http://127.0.0.1:8888/?sectorTest`. For an automated sweep use
`LIVE_RELOAD=0 npm run dev` so a mid-sweep rebuild does not reload the page and corrupt the
report.

### `SectorRenderTester`

A 256×192 offscreen canvas, `WebGLRenderer({ preserveDrawingBuffer: true })`, magenta
background (`0xff00ff`) as the "not covered" sentinel, a top-down camera over the sector
bounds. Per sector it runs the same two visibility passes as `RenderManager`
(`topLevelOnly = true`, then `false`), `renderer.compile`, then `SIMULATION_STEPS = 6`
iterations at `SIMULATION_STEP_MS = 200 ms` advancing `GLOBAL_UNIFORMS.globalTimeSeconds`,
updating updatables / materials / a local `InstancedSpriteBatcher`, and rendering.
`measureLuminance` reads pixels back (terrain only) → average luminance + % coverage;
`measureTerrainColors` averages the terrain `color` attribute; `dispose` frees all GL
resources (142+ sectors would otherwise pile up in the software rasterizer).

`console.error` / `console.warn` are monkey-patched to capture three.js shader compile / link
failures, which do not throw.

On `client.isDead` or a 240 s timeout it POSTs a note and reloads the page with `?start=N`
for a fresh worker.

### Query params

| Param | Default | Effect |
| --- | --- | --- |
| `start=N` | `0` | resume from sector index N (auto-set on worker death) |
| `only=a,b` | — | test only the listed sector ids |
| `emitters=0` | emitters **on** | disable emitter loading — **opposite** of `core.ts`'s default |
| `cache=1` | cache **off** | allow the decode cache — **opposite** of `core.ts` |
| `free=0` | free **on** | keep worker-side packages alive after each sector |
| `render=0` | render **on** | decode + instantiate only, skip the render / simulation phase |
| `forceRender=1` | off | submit every renderable once, ignoring visibility / frustum |
| `textures=auto\|rgba\|compressed` | `auto` | `auto` = S3TC when `WEBGL_compressed_texture_s3tc` is present, else RGBA |

Fixed: `SECTOR_TIMEOUT_MS = 240_000`, `SIMULATION_STEPS = 6`, `SIMULATION_STEP_MS = 200`.
`loadSettings` also forces `loadAudio: false` and full terrain / base-model / static-model /
batching.

### Report sink

The `devServerPlugin` in [vite.config.ts](../vite.config.ts) registers
`POST /sector-test/report`: it JSON-parses the body and **appends**
`{ t: <ISO timestamp>, ...body }` + `\n` to `sector-test-report.jsonl` at the repo root.
Responds `204` on success, `400` on a parse error. The file is git-ignored and **never
truncated** — **delete it before a clean sweep** or you will read stale rows mixed with new
ones.

Row shapes:

- **Note row** — `{ t, note }` for lifecycle events (`"sweep started: …"`,
  `"textures: mode=… -> …"`, `"worker lost at '<sector>', restarting at index N"`), plus a
  final `{ t, done: true }`.
- **Per-sector row** — `{ t, sector, index, total, ok, ms, warnings?, bsp?: [nodes,
  sections, zones], lum?: [before, after, coverage, colBefore, colAfter], phase?, error?,
  stack? }`. `ok: true` when no console errors; otherwise `phase` is
  `"decode" | "instantiate" | "render"` and `error` is either
  `"console errors during <phase>: …"` or the caught exception message.

## `?precacheSectors` — the cache-warming sibling

[src/sector-precache.ts](../src/sector-precache.ts), branched from `startCore()`. It walks
every `maps/NN_MM.unr` sector and decodes each through a single-worker `DecodeWorkerClient(1)`
to populate the OPFS decoded-library cache. No three.js, no rendering. Shows a progress UI
with a Cancel button.
