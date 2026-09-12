---
name: debug-l2
description: Diagnose a failing run of the headless L2 client by mapping the symptom to PLANE.md's TROUBLESHOOTING table, verifying crypto in isolation first. Use when the run reports FAIL, the client disconnects, packets look scrambled, or IN_GAME never prints.
argument-hint: "What symptom are you seeing?"
---

Diagnose the L2 client symptom: `$ARGUMENTS`. Source of truth for fixes is the **TROUBLESHOOTING**
section of [PLANE.md](../../../PLANE.md); constraints are in the `l2-guardrails` skill; build order is `build-l2`.

## Process

### 1. Build a tight feedback loop first
A **tight** loop goes red on _this_ bug and runs in milliseconds. The tightest one here is the crypto
round-trip — it needs no socket, so it isolates the crypto from every network cause before you touch either:
- `blowfishDecrypt(blowfishEncrypt(x, k), k).equals(x)`
- `gameCrypt.decrypt(gameCrypt.encrypt(x)).equals(x)` (two instances, same 8-byte key, `enabled=true`)

If either goes red, the bug is in the copied crypto — it was not pasted verbatim. Re-copy from PLANE.md and
stop; do not chase the socket over broken crypto. Only once both stay green do you move to the table below.

### 2. Map the symptom → cause → where the fix lives

The exact values (offsets, byte counts, key tails, field order) live in **one place** — the
`l2-guardrails` skill, backed by PLANE.md. This table only routes a symptom to the right rule;
read that rule, don't reconstruct it from memory.

| Symptom | Likely cause | Fix lives in |
| ------- | ------------ | ------------ |
| Blowfish garbage / round-trip fails | crypto not pasted verbatim / `node:crypto` / padding added | guardrails → Login crypto; PLANE.md → LoginCrypt |
| Init won't decode | wrong Init decode path | guardrails → Login crypto (Init) |
| LoginFail right after AuthLogin | RSA setup (modulus / padding / offsets) | guardrails → Login crypto (RSA) |
| Server drops you on login (checksum) | outgoing login packet build order | guardrails → Login crypto (outgoing) |
| Nothing happens on game server | textbook opcodes used | guardrails → Opcodes; PLANE.md → OPCODE MAP |
| AuthRequest rejected | wrong session-key field order | guardrails → Game FSM (AuthRequest) |
| CharacterSelected ignored | missing zero padding | guardrails → Game FSM (CharacterSelected) |
| No UserInfo / silent disconnect | enter-world sequence incomplete | guardrails → Game FSM (enter world) |
| Game packets scrambled | crypt flag ignored / wrong key tail | guardrails → Game crypto |
| Disconnect at ~60s | pings not answered | guardrails → Keepalive |
| Server rejects frames | double length prefix | guardrails → Framing |
| Duplicate EnterWorld warning | UserInfo arrived before CharSelected confirm | guardrails → Game FSM (skipped CharSelected) |
| Run hangs / never settles | run promise left pending on close | guardrails → Game FSM (server close) |

### 3. Instrument the failing transition
The FSM already logs transitions via `logState(from, to)`. Add a temporary hexdump
(`console.error(buf.subarray(0, n).toString('hex'))`) at the opcode dispatch of the state where it
stalls, compare the bytes against the PROTOCOL REFERENCE layout for that packet, then remove the
instrumentation once fixed.

**Never dump the decrypted `AuthLogin` plaintext** — it carries the login/password in ASCII at
`0x5E`/`0x6E`. If that packet must be inspected, zero those byte ranges before printing.

### 4. Re-run
After the fix, re-run via the `run` skill and confirm the report flips to `status: PASS`.
