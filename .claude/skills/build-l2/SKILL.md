---
name: build-l2
description: The build order for generating the headless Lineage 2 (HighFive, protocol 267) client from scratch out of PLANE.md — crypto first, self-tests before sockets, then net → login FSM → game FSM → one linear index.ts. Use when src/ is empty/absent, or the user asks to build, scaffold, generate, or start the client from the single prompt.
---

Build the L2 client from [PLANE.md](../../../PLANE.md) in a fixed order that surfaces crypto mistakes
before any socket exists. This skill owns the **order**; the `l2-guardrails` skill owns the **constraints**
(offsets, byte counts, opcode values, key order) — read a rule there, never reconstruct it here.

## Build order

Each step ends on a checkable criterion. Do not start a step until the previous criterion holds.

### 1. Read the spec

Read PLANE.md sections `PROJECT SETUP`, `REUSABLE CODE — COPY VERBATIM`, `OPCODE MAP`, `MODULE CONTRACTS`,
and the `l2-guardrails` skill. **Done when** you can name the six crypto modules and the `src/` layout
(including `src/types.ts`) without re-opening the file.

### 2. Scaffold the project

Create `package.json`, `tsconfig.json`, `.env.example`, the `src/` layout
(`net/ crypto/ login/ game/ debug/`), and **every COPY VERBATIM module that has no crypto dependency**,
pasted from its PLANE.md listing:

- `src/types.ts` — the only home for shared types;
- `src/game/Opcodes.ts` — the whole HighFive map (`login.in`/`login.out` + `game.in`/`game.out`),
  `ExtendedOpcode`, `ServerExtendedOpcode`;
- `src/net/PacketReader.ts`, `src/net/PacketWriter.ts`;
- `src/debug/DebugTools.ts` — imports only `types.ts`, so it compiles before any crypto exists.

Also write `src/config.ts` here (`loadConfig(): Config` per `MODULE CONTRACTS` — `dotenv`, `parseInt`,
a clear `Error` on any missing/invalid var). The `dev` script is
`node --experimental-strip-types src/index.ts` — **no `ts-node`**; pin dependency versions exact (no `^`).
Add a `typecheck` script; run `npm install`. **Never overwrite `.env`** — it holds real credentials; only
read it. **Done when** `npm install` completes and the five verbatim modules + `config.ts` typecheck on
their own (errors from files not yet written are expected at this point).

### 3. Crypto first

Copy **verbatim** from PLANE.md `REUSABLE CODE` into `src/crypto/`: `Blowfish.ts`, `NewCrypt.ts`,
`ScrambledRsaKey.ts`, `RsaCrypt.ts`, `LoginCrypt.ts`, `GameCrypt.ts`, and `selfTests.ts`
(`runLoginCryptoSelfTests`/`runGameCryptoSelfTests`, reporting through `check` from
`debug/DebugTools`, which step 2 already created). Blowfish/NewCrypt/LoginCrypt/GameCrypt are pure TS
(no `node:crypto`); `RsaCrypt` is the one exception (uses `node:crypto` for RSA-1024, NO_PADDING).
**Done when** all six modules + `selfTests.ts` compile.

### 4. Gate 1 — crypto green before any socket

This is the **tightest feedback loop** in the build: crypto self-tests run without a network, in milliseconds.
Wire `runLoginCryptoSelfTests()` + `runGameCryptoSelfTests()` (from `crypto/selfTests`) and run them.
**Done when** `npx tsc --noEmit`
is clean **and** all round-trips pass: Blowfish round-trip, LoginCrypt round-trip, GameCrypt round-trip
(first and second packet), and GameCrypt disabled-passthrough. A red self-test means the crypto was not pasted
verbatim — go back to step 3; do not write socket code over broken crypto.

### 5. Net layer

Copy `net/Connection.ts` **verbatim** from PLANE.md `REUSABLE CODE` — `Connection.send()` prepends the
2-byte LE length itself, callers never add it. (`PacketReader.ts` / `PacketWriter.ts` already exist from
step 2.) **Done when** it compiles and framing matches `l2-guardrails` → Framing.

### 6. Login FSM

Write `login/LoginClient.ts`: `WAIT_INIT → WAIT_GG_AUTH → WAIT_LOGIN_OK → WAIT_SERVER_LIST → WAIT_PLAY_OK`.
It imports `OPCODES` from `game/Opcodes.ts` (written in step 2 — PLANE.md keeps the *whole* map there,
login opcodes included; this one import is the allowed exception to the `login/` ↔ `game/` separation).
Import `Config` / `LoginResult` from `src/types.ts` — do not redefine them.
**Done when** it resolves a `LoginResult` carrying `loginOkId1/2`, `playOkId1/2`, `gameHost`, `gamePort`
(host and port taken from the picked `ServerList` record — see `l2-guardrails` → Flow & config).

### 7. Game FSM → IN_GAME

Write `game/GameClient.ts` (game opcodes are already in `game/Opcodes.ts` from step 2):
`WAIT_CRYPT_INIT → WAIT_CHAR_LIST → WAIT_CHAR_SELECTED → WAIT_USER_INFO → IN_GAME`, including
`RequestKeyMapping` + `EnterWorld` (each sent at most once), ping replies, and the 60s keepalive.
`runGame` takes `GameInput` and returns `Promise<Artifacts>` from `src/types.ts` — match
`MODULE CONTRACTS` exactly; `game/` must not import from `login/`.
**Done when** the enter-world and keepalive rules in `l2-guardrails` → Game FSM / Keepalive are satisfied.

### 8. One linear index.ts

Write `index.ts` as a single straight-line `main()`: config → self-tests → `runLogin` → `runGame` → one final
`report()`. **No `PHASE` env var, no per-stage functions, no per-stage report blocks.** The `statePath` array
is owned by `index.ts` and shared into both stages so the report shows one `IDLE → … → IN_GAME` sequence.
**Done when** the flow is a single pass with exactly one `=== REPORT ===`.

### 9. Gate 2 — typecheck then run

**Done when** `npx tsc --noEmit` is clean. Then hand off to the `run` skill to execute against the live server;
on FAIL, hand off to `debug-l2` with the observed symptom.

## Who owns which step (agent chain)

The steps above are owned by specialized subagents; the **orchestrator** (the main thread) drives the chain
and is the only party that can spawn a subagent — a subagent cannot spawn another, so any "escalate to X"
in an agent's report is a recommendation back to the orchestrator, not a direct call.

| Steps | Owner | Gate after |
| ----- | ----- | ---------- |
| 1–2 (scaffold: config, verbatim non-crypto modules, `npm install`) | **orchestrator** (do this before calling `crypto-porter`) | — |
| 3–4 (crypto + self-tests) | `crypto-porter` | gate 1 green, then `guardrails-reviewer` |
| 5–8 (net + login/game FSM + linear `index.ts`) | `fsm-builder` | then `guardrails-reviewer` |
| 9 (typecheck + run against server) | `run-debugger` (via `run`/`debug-l2`) | gate 2 |

So a from-scratch build is: orchestrator scaffolds → `crypto-porter` (gate 1) → `guardrails-reviewer` →
`fsm-builder` → `guardrails-reviewer` → `run-debugger` (gate 2). Re-run `guardrails-reviewer` after any fix
that touches framing, opcodes, crypto, the FSMs, or keepalive.
