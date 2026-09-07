# Project documentation

This folder is a self-contained English reference for the codebase. It is written so that a
person or a language model can make correct changes without first reading the whole project.

## What this project is

A from-scratch browser reimplementation of the **Lineage II — Chronicle 4: Scions of
Destiny** game client. It reads the *original* encrypted Unreal Engine 2 asset binaries
(`.unr .utx .usx .uax .ukx .u .ogg`) shipped with the retail client and renders the world
with [three.js](https://threejs.org) + WebGL.

Current state: a **streaming asset viewer**, not gameplay. You can fly a camera through the
whole map; sectors stream in and out around you. Player movement, physics, and skills exist
only as scaffolding (see [rendering.md](rendering.md#actors-live-vs-scaffolding)).

The code is deliberately messy in places. Reverse-engineering binary memory layouts forces
constant churn, so **do not "clean up" adjacent code as a side effect of a change**, and keep
the comments that cite disassembly addresses (`0x8a2ae0`) or UE source — they are load-bearing
documentation.

## Read this when…

| Document | Read it when you need to… |
| --- | --- |
| [architecture.md](architecture.md) | Understand the big picture: the two module graphs, the entry points, and how a sector travels from disk to screen. **Start here.** |
| [asset-pipeline.md](asset-pipeline.md) | Touch UE2 parsing: packages, `@l2js/core`, the `@unreal/*` classes, the decode library, the OPFS caches. |
| [decode-worker.md](decode-worker.md) | Touch the worker pool, the main↔worker message protocol, or `AssetManager` sector streaming. |
| [rendering.md](rendering.md) | Touch `RenderManager`, cameras, sky/fog/env, audio, actors, or anything about the UE2 coordinate convention. |
| [materials.md](materials.md) | Touch shaders, materials, the raw-GLSL import mechanism, or global uniforms. |
| [build-and-tooling.md](build-and-tooling.md) | Touch `vite.config.ts`, `package.json` scripts, tsconfig/eslint/knip, path aliases, or `tools/`. |
| [testing.md](testing.md) | Write a test, or run the `?sectorTest` full-map sweep harness. |
| [glossary.md](glossary.md) | Look up a project term (`DecodeLibrary`, "leaf actor", "warmup gate", `GD.*`) or find the right file fast. |

## Golden rules

1. **Graph separation.** The client/renderer bundle must never import `src/assets/unreal/**`
   or the UE2-parsing decoders. Anything that deserializes UE2 binaries is worker-side only.
   See [architecture.md](architecture.md#the-two-graph-model).
2. **No coordinate swizzle.** All world data stays in UE2 space (Z-up, left-handed). The
   handedness flip is baked into the camera projection matrix, not into the data. See
   [rendering.md](rendering.md#ue2-coordinate-convention).
3. **Aliases live in three files.** `vite.config.ts`, `tsconfig.json`, and `vitest.config.ts`
   each carry the path-alias map. Change one → change all three.
4. **Don't tidy reverse-engineering code.** Stylistic mess around binary layout parsing is
   intentional; ESLint downgrades those rules to `warn` on purpose.
5. **Bump the cache version.** When you change decode logic, increment
   `loadSettings.cache.version` in [src/core.ts](../src/core.ts) (currently `7`). It
   invalidates every cached sector in OPFS.

## Related files outside this folder

- [../CLAUDE.md](../CLAUDE.md) — the terse command/workflow cheat-sheet for contributors
  (build commands, "run answers in Russian", `?sectorTest` invocation). This folder is the
  deeper reference; `CLAUDE.md` is the quick card.
- [../README.md](../README.md) — project rationale and history (why C4, the roadmap).
