# Live-server networking (dev-only)

`src/net/**` connects the browser client to a real login/game server (currently developed
against `l2J-Mobius-CT-2.6-HighFive`, protocol 267) so the character's real position can drive
sector streaming instead of a free-flying debug camera. It is entirely opt-in and dev-only:
without a `.env`, or in a production build, the app boots exactly as the offline asset viewer
it always was.

Read [../server-protocol.md](../server-protocol.md) for the wire-format reference this layer
was built from — it documents the base opcode map and packet layouts. **Four corrections against
the actual server Java source win over that document**; they are listed at the top of
[src/net/opcodes.ts](../src/net/opcodes.ts) and must not be "fixed" back to it (reversed
keepalive direction/opcodes, `CharSelectionInfo` header, `CryptInit` body length, `UserInfo`
field order).

## Why this is safe to leave enabled in a dev checkout

- `loadNetConfig()` ([src/net/config.ts](../src/net/config.ts)) **never throws**. A missing or
  malformed `.env` degrades to `{ enabled: false }` plus one `console.warn` — it must never stop
  the renderer from booting.
- `config.enabled` additionally requires `import.meta.env.DEV`, so credentials baked in via
  `envPrefix: ["VITE_", "L2_"]` (vite.config.ts) never reach a production `build-dev` bundle.
  `.env.example` documents copying to a git-ignored `.env`.
- `?nonet` on the URL force-disables the session even with a working `.env` — keeps every
  offline workflow (debug camera presets, manual sector poking) reachable.
- `src/core.ts` calls `attachNetSession` fire-and-forget, concurrently with asset
  initialization. A dead server, wrong password, or missing character never blocks
  `startCore()`; failures surface in the HUD, one `console.error`, and `l2Session.snapshot`.
- The TCP bridge plugin (below) is `apply: "serve"` — absent entirely from `vite build`.

## The browser cannot open a TCP socket — the dev-server bridge

A page cannot make a raw TCP connection, so the login/game TCP streams are tunnelled through a
WebSocket to the Vite dev server, which splices it onto a real `net.Socket`:

```
browser                          vite dev server                    L2 server
L2Connection ── WebSocket ──► tcpBridgePlugin (tools/tcp-bridge-plugin.ts) ── net.Socket ──► login/game port
   (ws-transport.ts)              GET /l2-tcp?host=..&port=..
```

- [tools/tcp-bridge-plugin.ts](../tools/tcp-bridge-plugin.ts) — hooks the dev HTTP server's
  `upgrade` event (must `return` early for any path it doesn't own, or it kills Vite's own HMR
  upgrade listener on the same server). Deliberately dumb: no framing, no opcodes, no crypto —
  purely a byte pipe. Rejects any `host` that is neither RFC1918/loopback nor the configured
  `L2_LOGIN_IP` (`PRIVATE_IPV4` allowlist), so the dev server is never an open TCP proxy for
  arbitrary pages. Defers the WebSocket handshake until `net.Socket` fires `connect`, so the
  browser's `ws.onopen` genuinely means "the L2 server accepted us" rather than "the dev server
  accepted us" — otherwise a refused server just hangs the FSM in `WAIT_INIT` forever.
  Login and game are two independent, sequential WebSocket connections; the plugin holds no
  state across them.
- [src/net/ws-transport.ts](../src/net/ws-transport.ts) — `L2Connection`, the browser end.
  `FrameReassembler` splits the raw byte stream into L2 frames
  (`[uint16LE size incl. itself][body]`); a WebSocket message boundary is **not** a frame
  boundary, so this is exercised independently of any socket in
  [ws-transport.spec.ts](../src/net/ws-transport.spec.ts). A frame size `< 2` throws — that can
  only mean the stream desynchronised (almost always a crypto bug), and looping forever on it
  would be worse than crashing loudly.

## Binary layer

- [src/net/binary/packet-reader.ts](../src/net/binary/packet-reader.ts) /
  [packet-writer.ts](../src/net/binary/packet-writer.ts) — little-endian
  `Uint8Array`/`DataView` reader and writer, one port of `server-protocol.md`'s `PacketReader`
  from Node `Buffer`. Every read is bounds-checked and **throws** on a short body (the doc's
  original silently returns `undefined`) — a truncated packet must fail loud, not be acted on.
  `PacketWriter`'s `extended()` helper prepends the `0xD0` client-extended-packet prefix and a
  2-byte LE sub-opcode.
- [src/net/binary/bytes.ts](../src/net/binary/bytes.ts) — `concat`, `hex` (tracing dumps).
- [src/net/binary/bigint-bytes.ts](../src/net/binary/bigint-bytes.ts) — big-endian
  `BigInt`↔bytes conversion plus `modPow`, backing the RSA path below.
- Round-trip coverage: [packet-codec.spec.ts](../src/net/binary/packet-codec.spec.ts).

## Crypto — `src/net/crypto/`

Three unrelated ciphers, each dormant/active depending on protocol stage:

| File | Used for | Notes |
| --- | --- | --- |
| [blowfish.ts](../src/net/crypto/blowfish.ts) | login-server packets | classic Blowfish ECB, ported for `LoginCrypt`. |
| [new-crypt.ts](../src/net/crypto/new-crypt.ts) | login `Init` packet | `decXORPass` (reverse rolling XOR) + `appendChecksum`, applied around the Blowfish layer. |
| [login-crypt.ts](../src/net/crypto/login-crypt.ts) | login FSM | `LoginCrypt`: `Init` decrypts with a hardcoded `STATIC_KEY` via Blowfish, then reverse-XORs and drops the trailing 8 bytes to recover the session Blowfish key (`setSessionKey`). Every packet after `Init` uses that session key. Outgoing bodies are padded to a multiple of 4, get 8 zero bytes appended, padded to a multiple of 8, checksummed, then Blowfish-encrypted. |
| [game-crypt.ts](../src/net/crypto/game-crypt.ts) | game FSM | `GameCrypt`: a 16-byte shifting XOR cipher, keyed from `CryptInit`'s 8-byte XOR key plus a fixed 8-byte static tail, separate `keyIn`/`keyOut` state that shifts by packet size after every call. **Dormant by default** — enabled only if `CryptInit`'s encryption flag is non-zero, and on the HighFive dev target that flag tracks `ServerConfig.PACKET_ENCRYPTION` (`false` unless the `.ini` sets it), so the game stream is plaintext today; `CryptInit` itself is *never* encrypted regardless. |
| [rsa-crypt.ts](../src/net/crypto/rsa-crypt.ts) | `RequestAuthLogin` credential blob | RSA‑1024, `NO_PADDING`, `e = 65537`. With no padding the whole operation is literally `m^e mod n`, so there is no PKCS#1 DER detour (Node's `publicEncrypt` doesn't exist in the browser anyway) — `buildCredentialPlaintext` writes the login at offset `0x5E` (max 14 chars) and the password at `0x6E` (max 16 chars) into a 128-byte buffer, `encryptCredentials` does `bigint → modPow → bigint`. |
| [scrambled-rsa-key.ts](../src/net/crypto/scrambled-rsa-key.ts) | login `Init` | `unscrambleModulus` reverses the login server's byte-scramble of the 128-byte RSA modulus. |

Coverage: [crypto.spec.ts](../src/net/crypto/crypto.spec.ts) round-trips every cipher above.

Enable `globalThis.__L2_TRACE = true` in devtools to dump every decrypted packet body from
both `login-client.ts` and `game-client.ts` (read lazily, so it can be flipped mid-session).

## `opcodes.ts`

A `const … as const` map (never a TS `enum`, deliberately — `isolatedModules` plus the fact that
login's in/out numbers collide, e.g. `RequestGGAuth` and `PlayOk` are both `0x07`, hence the
`in`/`out` split under `login`/`game`). Carries `LOGIN_FAIL_REASONS` / `describeLoginFail` for
human-readable `LoginFail`/`PlayFail` reasons, and the four HighFive-specific corrections
documented at the top of the file (see above).

## Login FSM — `login-client.ts`

`runLogin(cfg, onState?)` returns a `Promise<LoginResult>` (the four session ids plus the
resolved game host/port), then closes its own connection. `game-client.ts` never imports it —
`LoginResult` is the entire contract between the two stages.

```
WAIT_INIT ─Init─► WAIT_GG_AUTH ─GGAuth──────────► WAIT_LOGIN_OK ─LoginOk─► WAIT_SERVER_LIST
                       │                                                        │
                       └─(server skips GGAuth, sends LoginOk directly)──────────┤
                                                                                 ▼
                                                            ServerList ── WAIT_PLAY_OK ─PlayOk─► DONE
```

Notable behavior baked into the FSM, not the doc:

- `resolveGameHost` — a LAN L2J-Mobius commonly advertises `127.0.0.1` in `ServerList`, which is
  the *browser's* loopback, not the real server's. Falls back to `L2_LOGIN_IP` for an
  unroutable advertised host, and always prefers `L2_GAME_PORT` over the advertised port.
- `L2_SERVER_ID` not present in `ServerList` → hard failure naming the ids that *are* present.
- Any `LoginFail`/`PlayFail` at any state → immediate reject with `describeLoginFail`.

## Game FSM — `game-client.ts`

`GameClient.start()` resolves once `UserInfo` arrives (`IN_GAME`), rejects on any handshake
failure. Never imports `login-client.ts`; `GameInput` is the whole contract received from the
login stage.

```
─ProtocolVersion─► WAIT_CRYPT_INIT ─CryptInit─► WAIT_CHAR_LIST ─CharSelectionInfo─►
WAIT_CHAR_SELECTED ─CharacterSelected─► (server: CharSelected, or straight to UserInfo) ─►
─RequestKeyMapping + EnterWorld─► WAIT_USER_INFO ─UserInfo─► IN_GAME ⇄ RequestNetPing/NetPing
```

Details worth knowing before touching this file:

- `ProtocolVersion` goes out **unencrypted** — `GameCrypt` isn't configured until `CryptInit`
  replies, and `CryptInit` itself is also always plaintext.
- `handleCryptInit` reads a **longer** body than `server-protocol.md`: result byte, 8-byte XOR
  key, `PACKET_ENCRYPTION` flag, server id (see `KeyPacket.java`). `result === 0` means the
  server rejected `L2_PROTOCOL` — surfaced as a named failure, not a silent hang.
  `AuthRequest`'s key order is `playOkId2, playOkId1, loginOkId1, loginOkId2` (`AuthLogin.java`);
  HighFive has no trailing language field some other doc versions expect.
  `CharacterSelected` requires exactly 14 trailing zero bytes (`CharacterSelect.java` reads
  `int, short, int, int, int`); `EnterWorld` requires exactly 104 (`b[32], 4×int, b[32], int`, +
  5 four-byte tracert entries) — skipping either is the classic "silent disconnect, no UserInfo"
  bug.
- `enterWorld()` is idempotent (`enteredWorld` flag): some servers send `UserInfo` before
  confirming `CharSelected`, so both code paths call it but it only fires once.
- Server extended packets (`0xFE` + 2-byte LE sub-opcode) and the torrent of unknown packets
  between `CharSelected` and `UserInfo` (skills/items/quest state) are counted and dropped, not
  treated as errors — only the first 20 log at `debug` level to avoid flooding the console.
- Once `IN_GAME`, every packet except `NetPing` is dropped.
- **Keepalive is reversed on this server** vs. the generic doc: the **client** sends
  `RequestNetPing` (`0xB1`, empty body, accepted only in `IN_GAME`) every `L2_PING_MS`; the
  server answers `NetPing` (`0xD9` + `int gameTime`). There is no server-initiated ping here.

## Parsers — `src/net/parsers/`

Small, focused readers for the three packets the session cares about the *contents* of:
[char-selection-info.ts](../src/net/parsers/char-selection-info.ts) (`CharacterInfo[]` — name,
slot, level, x/y/z; header carries two more fields than `server-protocol.md` lists),
[char-selected.ts](../src/net/parsers/char-selected.ts) (`CharSelectedBrief`),
[user-info.ts](../src/net/parsers/user-info.ts) (`UserInfoBrief` — x,y,z sit right after the
opcode, before name/objectId, unlike the doc's field order). Covered by
[parsers.spec.ts](../src/net/parsers/parsers.spec.ts).

## `session.ts` — orchestration

`L2Session` runs `runLogin` then `GameClient` back to back and exposes one
`SessionSnapshot` (`phase`, `charName`, `coords`, `tile`, ping state, …) via an `onSnapshot`
callback, plus a separate `onPlace(x, y, z, source)` callback for scene placement. Nothing here
imports three.js — that boundary is what lets this whole file run under Vitest's plain `node`
environment.

`CoordSource` — three sources of a coordinate arrive at different points in the handshake, and
a later, more authoritative one must never be clobbered by an earlier hint arriving out of
order:

| Source | Priority | When |
| --- | --- | --- |
| `charList` | 1 (lowest) | `CharSelectionInfo`, before a character is even chosen — starts sector streaming early |
| `charSelected` | 2 | `CharSelected`, after choosing a slot |
| `userInfo` | 3 (authoritative) | `UserInfo` — the character now exists in the world; never overridden |

`SessionPhase`: `IDLE → CONNECTING_LOGIN → AUTHENTICATING → CONNECTING_GAME → ENTERING_WORLD →
IN_GAME`, plus `DISCONNECTED` / `FAILED`. `L2Session.start()` never throws or rejects — all
failure is folded into the snapshot's `FAILED` phase plus one `console.error`. `restart()` tears
down and re-runs the whole thing (used by the HUD's Reconnect button).

## `src/game/net-world-bridge.ts` — the only file that imports both sides

`attachNetSession(renderManager, cfg)` is the single seam between `src/net/**` (three.js-free)
and `RenderManager` (network-free — it only gained two generic public methods,
`placePlayerAt(Vector3)` and `releasePlayerHold()`). It owns:

- **Placement**: `onPlace` moves the pawn via `placePlayerAt`; only the authoritative `userInfo`
  source triggers `watchForGround`.
- **The flying hold**: on an authoritative placement, the player floats (`placePlayerAt` holds
  it up) until the target sector actually exists and has had a couple of extra polls
  (`HOLD_EXTRA_POLLS`) for its static meshes' collision to register with `CollisionWorld` — then
  `releasePlayerHold()` hands control to gravity. If the tile isn't in the local asset install
  at all, or doesn't stream in within `HOLD_TIMEOUT_MS` (20 s), the player is left flying rather
  than sinking through missing collision. Poll interval `HOLD_POLL_MS` = 250 ms.
- **The HUD**: creates and repaints [net-hud.ts](../src/net/net-hud.ts)'s connection-status
  overlay from every `SessionSnapshot`.

## `net-hud.ts`

A plain DOM overlay (not a `lil-gui` folder — the `gui` instance in `render-manager.ts` is
module-private, and read-only text that changes every `UserInfo`/pong doesn't suit `lil-gui`'s
polled-controller model anyway). Throttled to `UPDATE_INTERVAL_MS` = 250 ms. Shown only when the
session is enabled, so a no-network boot is visually unchanged. Its "Reconnect" button calls
`session.restart()`.

## `world-tile.ts`

`coordToTile(x, y)` — the shared, three.js-free spec for world-coordinate → sector-id mapping
(`TILE_SIZE = 256 * 128`, zero at `(20, 18)`), matching both the server
(`gameserver/model/World.java`) and the client's own per-frame copy in
`RenderManager.getSectorId`. The sector id string doubles as the `.unr` package base name (e.g.
`"17_25"` ↔ `maps/17_25.unr`). Kept as a separate module specifically so it has unit coverage
([world-tile.spec.ts](../src/net/world-tile.spec.ts)) independent of `RenderManager`.

## Configuration

[src/net/config.ts](../src/net/config.ts) reads `L2_*` vars via `import.meta.env` (exposed by
`envPrefix: ["VITE_", "L2_"]` in `vite.config.ts`). Copy
[.env.example](../.env.example) to a git-ignored `.env`:

| Var | Default | Notes |
| --- | --- | --- |
| `L2_LOGIN_IP` | — (required) | login server host |
| `L2_LOGIN_PORT` | `2106` | |
| `L2_GAME_PORT` | `7777` | overrides whatever `ServerList` advertises — see `resolveGameHost` |
| `L2_USERNAME` / `L2_PASSWORD` | — (username required) | dev-only credentials, bundle-exposed by design (see "Why this is safe" above) |
| `L2_SERVER_ID` | `1` | must be present in `ServerList` |
| `L2_CHAR_SLOT` | `0` | must exist on the account |
| `L2_PROTOCOL` | `267` | HighFive; must be in the server's `ServerConfig.PROTOCOL_LIST` |
| `L2_PING_MS` | `30000` | client-initiated keepalive interval, see the reversed-ping note above |

`?nonet` on the URL disables the session regardless of `.env`.

## Testing

Unlike the rest of the codebase (see [testing.md](testing.md)), this layer has real unit
coverage because it is pure logic with no three.js/DOM/UE2-binary dependency:
`packet-codec.spec.ts`, `crypto.spec.ts`, `parsers.spec.ts`, `world-tile.spec.ts`,
`ws-transport.spec.ts`. Add tests here the normal way (`npx vitest run src/net/...`); there is
no equivalent of `?sectorTest` for the network stack — testing it end-to-end means running
`npm run dev` against a real login/game server.
