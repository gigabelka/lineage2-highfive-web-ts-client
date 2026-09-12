# TEST PROMPT — Build a Headless Lineage 2 Auto-Login Client (Node.js 24.15.0 + TypeScript)

> **This whole file is a single prompt.** Copy everything below the line and give it to any LLM.
> The LLM must produce a working project. The only success goal: **a character automatically
> connects, authenticates, enters the game world, and stays connected (answers server pings)**.
>
> This prompt is deliberately self-contained: every opcode, byte layout, and crypto routine you
> need is included inline. Do **not** invent values — use only what is written here.
>
> **Game-server encryption is flag-driven.** Apply the 16-byte shifting XOR cipher only when
> CryptInit reports a non-zero flag; when the flag is `0`, the stream is plaintext. Honor whatever
> flag the server sends — do not hard-code encryption on or off.
>
> **Verified against implementation.** This prompt has been reconciled with a working TypeScript
> implementation. Code snippets, opcode values, packet layouts, and state-machine behavior reflect what the
> reference source actually does, including edge cases such as skipped `GGAuth`, skipped
> `CharSelected`, server-side extended opcodes (`0xFE`), and the exact `Connection.send()` contract.

---

## ROLE & GOAL

You are a senior TypeScript network engineer. Build a small, headless **Lineage 2 game client**
that targets a **HighFive** server (protocol `267`).

The program must, with **no human interaction**:

1. Connect to the **Login Server** over TCP, authenticate with a username/password, pick a game
   server from the server list, and obtain session keys.
2. Connect to the **Game Server** over TCP, authenticate with those session keys, select a
   character by slot index, and **enter the world**.
3. Print `IN_GAME` to the console when the character is in the world.
4. **Keep the connection alive**: when the server sends a ping, reply with a pong. Stay connected.

**Definition of done:** running `npm run dev` connects end-to-end against a real server, logs
`IN_GAME`, keeps answering pings for at least 60 seconds without crashing, and `npx tsc --noEmit`
reports no type errors.

### Out of scope (do NOT build these)

No REST API, no WebSocket server, no web dashboard, no combat, no movement, no inventory logic,
no database, no dependency-injection framework. Keep it small and single-purpose. One small class
per file is fine. All code comments in English.

---

## HARD CONSTRAINTS (read carefully — most failures come from breaking these)

1. **Node.js 24.15.0**, **TypeScript** (strict mode on).
2. **All integers are little-endian.**
3. **Packet framing:** every packet on the wire is `[uint16LE size][1-byte opcode][payload...]`.
   The 2-byte size field **includes itself**. Example: a 5-byte packet has size `0x0005`.
4. **Strings are UTF-16LE, null-terminated** (two `0x00` bytes terminator), unless stated otherwise.
5. **Extended packets:** client opcodes `>= 0xD0` are written as `[0xD0][2-byte sub-opcode LE][...]`.
   The server may also send extended packets prefixed with `0xFE`; read the 2-byte sub-opcode that
   follows and dispatch accordingly.
6. **Use the opcodes from the OPCODE MAP below — never the "textbook" L2 opcodes.** This server is
   uses its own opcode set, confirmed by packet captures.
7. **Login uses crypto; game crypto is flag-driven.** Login Server: Blowfish ECB + RSA + XOR
   checksum (always on). Game Server: after `CryptInit` (`0x2E`), read `encryptionFlag`. If `flag != 0`,
   enable the 16-byte shifting XOR cipher and apply it to every subsequent sent/received body; if
   `flag == 0`, the stream is plaintext. The first game packet (`ProtocolVersion 0x0E`) is always
   sent raw. Honor the flag — never hard-code encryption on or off.
8. Never block the event loop. Use Node's `net` module with proper TCP stream reassembly.

---

## PROJECT SETUP

Create this structure:

```
l2-headless-client/
├── package.json
├── tsconfig.json
├── .env.example
├── .env                 (the tester fills this in; do not commit real credentials)
└── src/
    ├── index.ts             # entry point: login, enter world, keepalive — one run
    ├── config.ts            # load + validate .env
    ├── types.ts             # shared types/contracts (Config, LoginResult, GameInput, …)
    ├── net/
    │   ├── Connection.ts     # TCP socket + packet reassembly
    │   ├── PacketReader.ts    # binary reader (LE)
    │   └── PacketWriter.ts    # binary writer (LE)
    ├── crypto/
    │   ├── Blowfish.ts       # Blowfish ECB encrypt/decrypt
    │   ├── NewCrypt.ts       # checksum + rolling-XOR helpers
    │   ├── ScrambledRsaKey.ts # unscramble RSA modulus
    │   ├── RsaCrypt.ts       # encrypt credentials
    │   ├── LoginCrypt.ts     # login packet enc/dec orchestration
    │   ├── GameCrypt.ts      # game-server 16-byte shifting XOR (HighFive)
    │   └── selfTests.ts      # crypto round-trips, run before any socket I/O
    ├── debug/
    │   └── DebugTools.ts      # self-debug toolkit: check counters, [STATE] log, final report
    ├── login/
    │   └── LoginClient.ts     # login-server state machine
    └── game/
        ├── GameClient.ts      # game-server state machine
        └── Opcodes.ts        # HighFive opcode map
```

### `package.json`

```json
{
  "name": "l2-headless-client",
  "version": "1.0.0",
  "type": "commonjs",
  "engines": { "node": ">=24.15.0" },
  "scripts": {
    "dev": "node --experimental-strip-types src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "dotenv": "17.2.1"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "@types/node": "24.3.0"
  }
}
```

> **Runner: native TypeScript, no `ts-node`.** Node 24 strips types itself — `npm run dev` runs
> `src/index.ts` directly. Because this is plain type-stripping (not a full transform), the code
> **must avoid TS syntax that emits runtime code**: no `enum`, no `namespace`, no
> constructor parameter-properties (`constructor(private x: T)`) — declare fields in the class body
> and assign in the constructor. `Opcodes.ts` is a `const … as const` object, never an `enum`.
> `tsconfig.json` sets `"isolatedModules": true` so `tsc` flags any of these before runtime.
> Dependency versions are **pinned exact** (no `^`) so `tsc` behaves identically across runs.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

> `strict` is on but **`noUncheckedIndexedAccess` is deliberately off**. The verbatim crypto uses
> non-null assertions (`this.S0[i]!`) that are correct as written under this config — do not remove
> them and do not enable `noUncheckedIndexedAccess` (it would force `undefined` handling into every
> reader/writer and add errors). `isolatedModules` + `skipLibCheck` keep the typecheck fast and
> aligned with the native-TS runner.

### `.env.example`

```bash
L2_LOGIN_IP=192.168.0.33     # Login server IP
L2_LOGIN_PORT=2106        # Login server port
L2_GAME_PORT=7777         # Game server port (host comes from the server list)
L2_USERNAME=qwerty          # Account login (max 14 chars)
L2_PASSWORD=qwerty          # Account password (max 16 chars)
L2_SERVER_ID=2            # Server id to pick from the login server list
L2_CHAR_SLOT=0            # Character slot index (0-based)
L2_PROTOCOL=267           # HighFive protocol (this prompt targets 267 only)
```

`config.ts` exports `loadConfig(): Config` (type from `src/types.ts`): loads these via `dotenv`,
converts numbers with `parseInt`, and throws a clear error if any required value is missing.

### Entry point (`index.ts`)

There are no build phases and no `PHASE` environment variable. `index.ts` is a single linear
program: running `npm run dev` executes the whole flow in one pass.

1. Load and validate the config.
2. Run the crypto self-tests (`runLoginCryptoSelfTests()` + `runGameCryptoSelfTests()`) once,
   before any socket I/O.
3. Connect to the login server, authenticate, and obtain the session ids + game server
   host/port.
4. Open a fresh game connection with that session data, select the character, and enter the
   world.
5. Print `IN_GAME`, answer server pings for at least 60 seconds, then close the socket cleanly
   and exit.

If any step fails (crypto self-test, `LoginFail`/`PlayFail`, or the server closing the socket
before `UserInfo`), stop, print the report with `status: FAIL`, and exit non-zero.

---

## OPCODE MAP (CRITICAL — HighFive)

This is the **HighFive (protocol 267)** opcode set. Put these in `src/game/Opcodes.ts`.

### Login Server opcodes

| Direction | Name               | Opcode |
| --------- | ------------------ | ------ |
| ← server  | Init               | `0x00` |
| → client  | RequestGGAuth      | `0x07` |
| ← server  | GGAuth             | `0x0B` |
| → client  | RequestAuthLogin   | `0x00` |
| ← server  | LoginOk            | `0x03` |
| ← server  | LoginFail          | `0x01` |
| → client  | RequestServerList  | `0x05` |
| ← server  | ServerList         | `0x04` |
| → client  | RequestServerLogin | `0x02` |
| ← server  | PlayOk             | `0x07` |
| ← server  | PlayFail           | `0x06` |

### Game Server opcodes (HighFive)

| Step | Name                   | Dir | Opcode                         |
| ---- | ---------------------- | --- | ------------------------------ |
| 1    | ProtocolVersion        | →   | `0x0E`                         |
| 2    | CryptInit              | ←   | `0x2E`                         |
| 3    | AuthRequest            | →   | `0x2B`                         |
| 4    | CharSelectInfo         | ←   | `0x09`                         |
| 5    | CharacterSelected      | →   | `0x12`                         |
| 6    | CharSelected (confirm) | ←   | `0x0B`                         |
| 7    | RequestKeyMapping      | →   | `0x21` (sent as `0xD0 0x0021`) |
| 8    | EnterWorld             | →   | `0x11`                         |
| 9    | UserInfo               | ←   | `0x32`                         |
| -    | NetPingRequest         | ←   | `0xD3` or `0xFE 0x00D3`        |
| -    | NetPing (pong)         | →   | `0xA8`                         |

> Extended opcodes: the client prefixes its extended packets with `0xD0` followed by a 2-byte
> little-endian sub-opcode (e.g., `RequestKeyMapping` is sent as `0xD0 0x0021`). The server may also
> send extended packets prefixed with `0xFE`; treat `0xFE 0x00D3` as a valid `NetPingRequest`.
> Store `ExtendedOpcode = 0xD0` and `ServerExtendedOpcode = 0xFE` alongside the opcode map.

> The first packet after `ProtocolVersion` is always `CryptInit 0x2E`; read its XOR key and flag,
> then init `GameCrypt` per HARD CONSTRAINTS #7 before reading anything else.

### `src/game/Opcodes.ts` — COPY VERBATIM

A `const … as const` object (never an `enum` — see PROJECT SETUP runner note). Some login
values collide by number (e.g. `RequestGGAuth` and `PlayOk` are both `0x07`), so keep the
`in` / `out` split.

```typescript
// HighFive (protocol 267) opcode map. Values are bytes unless noted.
export const OPCODES = {
  login: {
    in: {
      Init: 0x00,
      GGAuth: 0x0b,
      LoginOk: 0x03,
      LoginFail: 0x01,
      ServerList: 0x04,
      PlayOk: 0x07,
      PlayFail: 0x06,
    },
    out: {
      RequestGGAuth: 0x07,
      RequestAuthLogin: 0x00,
      RequestServerList: 0x05,
      RequestServerLogin: 0x02,
    },
  },
  game: {
    in: {
      CryptInit: 0x2e,
      CharSelectInfo: 0x09,
      CharSelected: 0x0b,
      UserInfo: 0x32,
      NetPingRequest: 0xd3, // also arrives as 0xFE 0x00D3
    },
    out: {
      ProtocolVersion: 0x0e,
      AuthRequest: 0x2b,
      CharacterSelected: 0x12,
      RequestKeyMapping: 0x0021, // sent as the extended packet 0xD0 0x0021
      EnterWorld: 0x11,
      NetPing: 0xa8,
    },
  },
} as const;

export const ExtendedOpcode = 0xd0; // client extended-packet prefix
export const ServerExtendedOpcode = 0xfe; // server extended-packet prefix
```

---

## REUSABLE CODE — COPY VERBATIM

These are correct, working implementations. Copy them into the listed files. You only need to
**wire them into the flow**; do not rewrite the algorithms.

### `src/types.ts` (shared types — the only home for cross-module types)

```typescript
// The single source of shared types. config.ts, net/, login/, game/, debug/ and index.ts
// all import from here. login/ and game/ must NOT import from each other — anything they
// both need lives in this file and is threaded through index.ts.

export interface Config {
  loginIp: string;
  loginPort: number;
  gamePort: number;
  username: string;
  password: string;
  serverId: number;
  charSlot: number;
  protocol: number;
}

// Resolved by the login stage, carried in memory into the game stage.
export interface LoginResult {
  loginOkId1: number;
  loginOkId2: number;
  playOkId1: number;
  playOkId2: number;
  gameHost: string;
  gamePort: number;
}

// What runGame() needs: the login result plus the account name for AuthRequest.
export type GameInput = LoginResult & { username: string };

// key=value session data printed in the final report.
export type Artifacts = Record<string, string | number>;

export type LoginState =
  | "WAIT_INIT"
  | "WAIT_GG_AUTH"
  | "WAIT_LOGIN_OK"
  | "WAIT_SERVER_LIST"
  | "WAIT_PLAY_OK";

export type GameState =
  | "WAIT_CRYPT_INIT"
  | "WAIT_CHAR_LIST"
  | "WAIT_CHAR_SELECTED"
  | "WAIT_USER_INFO"
  | "IN_GAME";

export type AnyState = "IDLE" | LoginState | GameState;
```

### `src/net/PacketReader.ts`

```typescript
// Little-endian binary reader over a Buffer. Advances an internal position as it reads.
export class PacketReader {
  private buf: Buffer;
  private pos: number;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  readUInt8(): number {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readUInt16LE(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readInt16LE(): number {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readInt32LE(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt64LE(): bigint {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readFloatLE(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  readDoubleLE(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  // Returns a COPY of the next n bytes.
  readBytes(n: number): Buffer {
    const out = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  // UTF-16LE up to (and consuming) the two-byte 0x0000 terminator.
  readStringUTF16(): string {
    let end = this.pos;
    while (end + 1 < this.buf.length && !(this.buf[end] === 0 && this.buf[end + 1] === 0)) {
      end += 2;
    }
    const s = this.buf.toString("utf16le", this.pos, end);
    this.pos = end + 2;
    return s;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }
}
```

### `src/net/PacketWriter.ts`

```typescript
// Little-endian binary writer. Accumulates chunks; toBuffer() concatenates them.
// Every mutator returns `this` for chaining.
export class PacketWriter {
  private chunks: Buffer[] = [];

  writeUInt8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    this.chunks.push(b);
    return this;
  }

  writeUInt16LE(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v & 0xffff, 0);
    this.chunks.push(b);
    return this;
  }

  writeInt32LE(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0, 0);
    this.chunks.push(b);
    return this;
  }

  writeInt64LE(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v, 0);
    this.chunks.push(b);
    return this;
  }

  writeBytes(b: Buffer | Uint8Array): this {
    this.chunks.push(Buffer.from(b));
    return this;
  }

  writeStringNullUTF16(s: string): this {
    this.chunks.push(Buffer.from(s, "utf16le"));
    this.chunks.push(Buffer.from([0x00, 0x00]));
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
```

### `src/net/Connection.ts` (TCP + packet reassembly)

```typescript
import { Socket } from "node:net";

export class Connection {
  private socket = new Socket();
  private recv = Buffer.alloc(0);
  onPacket: (packet: Buffer) => void = () => {}; // full frame INCLUDING 2-byte size
  onConnect: () => void = () => {};
  onClose: () => void = () => {};
  connect(host: string, port: number): void {
    this.socket.connect(port, host, () => this.onConnect());
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => this.onClose());
    this.socket.on("error", (e) => console.error("TCP error", e));
  }
  /** Send a body (opcode + payload, WITHOUT size). This prepends the 2-byte LE length. */
  send(body: Buffer): void {
    const size = body.length + 2;
    const frame = Buffer.alloc(size);
    frame.writeUInt16LE(size, 0);
    body.copy(frame, 2);
    this.socket.write(frame);
  }
  private handleData(chunk: Buffer): void {
    this.recv = Buffer.concat([this.recv, chunk]);
    while (this.recv.length >= 2) {
      const len = this.recv.readUInt16LE(0);
      if (len < 2 || this.recv.length < len) break; // wait for more bytes
      const frame = this.recv.subarray(0, len);
      this.recv = this.recv.subarray(len);
      this.onPacket(Buffer.from(frame));
    }
  }
  close(): void {
    this.socket.destroy();
  }
}
```

> Build outgoing frames by passing the raw body (opcode + payload) to `Connection.send(...)`, which
> prepends `[uint16LE size]` where `size = body.length + 2`. For login packets after the session key
> is set, encrypt the body with `LoginCrypt.encrypt(...)` before calling `send(...)`; the length prefix
> is always measured on the encrypted body.

### `src/crypto/Blowfish.ts` (Blowfish ECB, no padding — full pure-TS implementation)

> **Blowfish in full — no external dependency.** Blowfish is a symmetric block cipher: 8-byte
> Blowfish ECB, no padding, 8-byte blocks, 16 Feistel rounds. S-boxes and P-array are seeded from
> the hexadecimal digits of pi. Pure TypeScript — do not use `node:crypto`. Verify the round-trip
> `blowfishDecrypt(blowfishEncrypt(x, k), k).equals(x)` before any socket I/O.

```typescript
// Blowfish block cipher, ECB mode, NO padding. 8-byte blocks, 16 Feistel rounds.
// S-boxes (S0..S3) and the P-array are seeded with the hexadecimal digits of pi.
// Self-contained: no node:crypto. Verify blowfishDecrypt(blowfishEncrypt(x, k), k) === x first.

class BlowfishEngine {
  // P-array initialization vector (hex digits of pi): 18 32-bit subkeys.
  // prettier-ignore
  static readonly KP: number[] = [
    0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0, 0x082efa98, 0xec4e6c89, 0x452821e6,
    0x38d01377, 0xbe5466cf, 0x34e90c6c, 0xc0ac29b7, 0xc97c50dd, 0x3f84d5b5, 0xb5470917, 0x9216d5d9, 0x8979fb1b,
  ];

  // S-box 0 initialization vector (hex digits of pi).
  // prettier-ignore
  static readonly KS0: number[] = [
    0xd1310ba6, 0x98dfb5ac, 0x2ffd72db, 0xd01adfb7, 0xb8e1afed, 0x6a267e96, 0xba7c9045, 0xf12c7f99, 0x24a19947, 0xb3916cf7, 0x0801f2e2, 0x858efc16, 0x636920d8, 0x71574e69, 0xa458fea3, 0xf4933d7e, 0x0d95748f, 0x728eb658, 0x718bcd58, 0x82154aee, 0x7b54a41d, 0xc25a59b5, 0x9c30d539, 0x2af26013, 0xc5d1b023, 0x286085f0, 0xca417918, 0xb8db38ef, 0x8e79dcb0, 0x603a180e, 0x6c9e0e8b, 0xb01e8a3e, 0xd71577c1, 0xbd314b27, 0x78af2fda, 0x55605c60, 0xe65525f3, 0xaa55ab94, 0x57489862, 0x63e81440, 0x55ca396a, 0x2aab10b6, 0xb4cc5c34, 0x1141e8ce, 0xa15486af, 0x7c72e993, 0xb3ee1411, 0x636fbc2a, 0x2ba9c55d, 0x741831f6, 0xce5c3e16, 0x9b87931e, 0xafd6ba33, 0x6c24cf5c, 0x7a325381, 0x28958677, 0x3b8f4898, 0x6b4bb9af, 0xc4bfe81b, 0x66282193, 0x61d809cc, 0xfb21a991, 0x487cac60, 0x5dec8032,
    0xef845d5d, 0xe98575b1, 0xdc262302, 0xeb651b88, 0x23893e81, 0xd396acc5, 0x0f6d6ff3, 0x83f44239, 0x2e0b4482, 0xa4842004, 0x69c8f04a, 0x9e1f9b5e, 0x21c66842, 0xf6e96c9a, 0x670c9c61, 0xabd388f0, 0x6a51a0d2, 0xd8542f68, 0x960fa728, 0xab5133a3, 0x6eef0b6c, 0x137a3be4, 0xba3bf050, 0x7efb2a98, 0xa1f1651d, 0x39af0176, 0x66ca593e, 0x82430e88, 0x8cee8619, 0x456f9fb4, 0x7d84a5c3, 0x3b8b5ebe, 0xe06f75d8, 0x85c12073, 0x401a449f, 0x56c16aa6, 0x4ed3aa62, 0x363f7706, 0x1bfedf72, 0x429b023d, 0x37d0d724, 0xd00a1248, 0xdb0fead3, 0x49f1c09b, 0x075372c9, 0x80991b7b, 0x25d479d8, 0xf6e8def7, 0xe3fe501a, 0xb6794c3b, 0x976ce0bd, 0x04c006ba, 0xc1a94fb6, 0x409f60c4, 0x5e5c9ec2, 0x196a2463, 0x68fb6faf, 0x3e6c53b5, 0x1339b2eb, 0x3b52ec6f, 0x6dfc511f, 0x9b30952c, 0xcc814544, 0xaf5ebd09,
    0xbee3d004, 0xde334afd, 0x660f2807, 0x192e4bb3, 0xc0cba857, 0x45c8740f, 0xd20b5f39, 0xb9d3fbdb, 0x5579c0bd, 0x1a60320a, 0xd6a100c6, 0x402c7279, 0x679f25fe, 0xfb1fa3cc, 0x8ea5e9f8, 0xdb3222f8, 0x3c7516df, 0xfd616b15, 0x2f501ec8, 0xad0552ab, 0x323db5fa, 0xfd238760, 0x53317b48, 0x3e00df82, 0x9e5c57bb, 0xca6f8ca0, 0x1a87562e, 0xdf1769db, 0xd542a8f6, 0x287effc3, 0xac6732c6, 0x8c4f5573, 0x695b27b0, 0xbbca58c8, 0xe1ffa35d, 0xb8f011a0, 0x10fa3d98, 0xfd2183b8, 0x4afcb56c, 0x2dd1d35b, 0x9a53e479, 0xb6f84565, 0xd28e49bc, 0x4bfb9790, 0xe1ddf2da, 0xa4cb7e33, 0x62fb1341, 0xcee4c6e8, 0xef20cada, 0x36774c01, 0xd07e9efe, 0x2bf11fb4, 0x95dbda4d, 0xae909198, 0xeaad8e71, 0x6b93d5a0, 0xd08ed1d0, 0xafc725e0, 0x8e3c5b2f, 0x8e7594b7, 0x8ff6e2fb, 0xf2122b64, 0x8888b812, 0x900df01c,
    0x4fad5ea0, 0x688fc31c, 0xd1cff191, 0xb3a8c1ad, 0x2f2f2218, 0xbe0e1777, 0xea752dfe, 0x8b021fa1, 0xe5a0cc0f, 0xb56f74e8, 0x18acf3d6, 0xce89e299, 0xb4a84fe0, 0xfd13e0b7, 0x7cc43b81, 0xd2ada8d9, 0x165fa266, 0x80957705, 0x93cc7314, 0x211a1477, 0xe6ad2065, 0x77b5fa86, 0xc75442f5, 0xfb9d35cf, 0xebcdaf0c, 0x7b3e89a0, 0xd6411bd3, 0xae1e7e49, 0x00250e2d, 0x2071b35e, 0x226800bb, 0x57b8e0af, 0x2464369b, 0xf009b91e, 0x5563911d, 0x59dfa6aa, 0x78c14389, 0xd95a537f, 0x207d5ba2, 0x02e5b9c5, 0x83260376, 0x6295cfa9, 0x11c81968, 0x4e734a41, 0xb3472dca, 0x7b14a94a, 0x1b510052, 0x9a532915, 0xd60f573f, 0xbc9bc6e4, 0x2b60a476, 0x81e67400, 0x08ba6fb5, 0x571be91f, 0xf296ec6b, 0x2a0dd915, 0xb6636521, 0xe7b9f9b6, 0xff34052e, 0xc5855664, 0x53b02d5d, 0xa99f8fa1, 0x08ba4799, 0x6e85076a,
  ];

  // S-box 1 initialization vector (hex digits of pi).
  // prettier-ignore
  static readonly KS1: number[] = [
    0x4b7a70e9, 0xb5b32944, 0xdb75092e, 0xc4192623, 0xad6ea6b0, 0x49a7df7d, 0x9cee60b8, 0x8fedb266, 0xecaa8c71, 0x699a17ff, 0x5664526c, 0xc2b19ee1, 0x193602a5, 0x75094c29, 0xa0591340, 0xe4183a3e, 0x3f54989a, 0x5b429d65, 0x6b8fe4d6, 0x99f73fd6, 0xa1d29c07, 0xefe830f5, 0x4d2d38e6, 0xf0255dc1, 0x4cdd2086, 0x8470eb26, 0x6382e9c6, 0x021ecc5e, 0x09686b3f, 0x3ebaefc9, 0x3c971814, 0x6b6a70a1, 0x687f3584, 0x52a0e286, 0xb79c5305, 0xaa500737, 0x3e07841c, 0x7fdeae5c, 0x8e7d44ec, 0x5716f2b8, 0xb03ada37, 0xf0500c0d, 0xf01c1f04, 0x0200b3ff, 0xae0cf51a, 0x3cb574b2, 0x25837a58, 0xdc0921bd, 0xd19113f9, 0x7ca92ff6, 0x94324773, 0x22f54701, 0x3ae5e581, 0x37c2dadc, 0xc8b57634, 0x9af3dda7, 0xa9446146, 0x0fd0030e, 0xecc8c73e, 0xa4751e41, 0xe238cd99, 0x3bea0e2f, 0x3280bba1, 0x183eb331,
    0x4e548b38, 0x4f6db908, 0x6f420d03, 0xf60a04bf, 0x2cb81290, 0x24977c79, 0x5679b072, 0xbcaf89af, 0xde9a771f, 0xd9930810, 0xb38bae12, 0xdccf3f2e, 0x5512721f, 0x2e6b7124, 0x501adde6, 0x9f84cd87, 0x7a584718, 0x7408da17, 0xbc9f9abc, 0xe94b7d8c, 0xec7aec3a, 0xdb851dfa, 0x63094366, 0xc464c3d2, 0xef1c1847, 0x3215d908, 0xdd433b37, 0x24c2ba16, 0x12a14d43, 0x2a65c451, 0x50940002, 0x133ae4dd, 0x71dff89e, 0x10314e55, 0x81ac77d6, 0x5f11199b, 0x043556f1, 0xd7a3c76b, 0x3c11183b, 0x5924a509, 0xf28fe6ed, 0x97f1fbfa, 0x9ebabf2c, 0x1e153c6e, 0x86e34570, 0xeae96fb1, 0x860e5e0a, 0x5a3e2ab3, 0x771fe71c, 0x4e3d06fa, 0x2965dcb9, 0x99e71d0f, 0x803e89d6, 0x5266c825, 0x2e4cc978, 0x9c10b36a, 0xc6150eba, 0x94e2ea78, 0xa5fc3c53, 0x1e0a2df4, 0xf2f74ea7, 0x361d2b3d, 0x1939260f, 0x19c27960,
    0x5223a708, 0xf71312b6, 0xebadfe6e, 0xeac31f66, 0xe3bc4595, 0xa67bc883, 0xb17f37d1, 0x018cff28, 0xc332ddef, 0xbe6c5aa5, 0x65582185, 0x68ab9802, 0xeecea50f, 0xdb2f953b, 0x2aef7dad, 0x5b6e2f84, 0x1521b628, 0x29076170, 0xecdd4775, 0x619f1510, 0x13cca830, 0xeb61bd96, 0x0334fe1e, 0xaa0363cf, 0xb5735c90, 0x4c70a239, 0xd59e9e0b, 0xcbaade14, 0xeecc86bc, 0x60622ca7, 0x9cab5cab, 0xb2f3846e, 0x648b1eaf, 0x19bdf0ca, 0xa02369b9, 0x655abb50, 0x40685a32, 0x3c2ab4b3, 0x319ee9d5, 0xc021b8f7, 0x9b540b19, 0x875fa099, 0x95f7997e, 0x623d7da8, 0xf837889a, 0x97e32d77, 0x11ed935f, 0x16681281, 0x0e358829, 0xc7e61fd6, 0x96dedfa1, 0x7858ba99, 0x57f584a5, 0x1b227263, 0x9b83c3ff, 0x1ac24696, 0xcdb30aeb, 0x532e3054, 0x8fd948e4, 0x6dbc3128, 0x58ebf2ef, 0x34c6ffea, 0xfe28ed61, 0xee7c3c73,
    0x5d4a14d9, 0xe864b7e3, 0x42105d14, 0x203e13e0, 0x45eee2b6, 0xa3aaabea, 0xdb6c4f15, 0xfacb4fd0, 0xc742f442, 0xef6abbb5, 0x654f3b1d, 0x41cd2105, 0xd81e799e, 0x86854dc7, 0xe44b476a, 0x3d816250, 0xcf62a1f2, 0x5b8d2646, 0xfc8883a0, 0xc1c7b6a3, 0x7f1524c3, 0x69cb7492, 0x47848a0b, 0x5692b285, 0x095bbf00, 0xad19489d, 0x1462b174, 0x23820e00, 0x58428d2a, 0x0c55f5ea, 0x1dadf43e, 0x233f7061, 0x3372f092, 0x8d937e41, 0xd65fecf1, 0x6c223bdb, 0x7cde3759, 0xcbee7460, 0x4085f2a7, 0xce77326e, 0xa6078084, 0x19f8509e, 0xe8efd855, 0x61d99735, 0xa969a7aa, 0xc50c06c2, 0x5a04abfc, 0x800bcadc, 0x9e447a2e, 0xc3453484, 0xfdd56705, 0x0e1e9ec9, 0xdb73dbd3, 0x105588cd, 0x675fda79, 0xe3674340, 0xc5c43465, 0x713e38d8, 0x3d28f89e, 0xf16dff20, 0x153e21e7, 0x8fb03d4a, 0xe6e39f2b, 0xdb83adf7,
  ];

  // S-box 2 initialization vector (hex digits of pi).
  // prettier-ignore
  static readonly KS2: number[] = [
    0xe93d5a68, 0x948140f7, 0xf64c261c, 0x94692934, 0x411520f7, 0x7602d4f7, 0xbcf46b2e, 0xd4a20068, 0xd4082471, 0x3320f46a, 0x43b7d4b7, 0x500061af, 0x1e39f62e, 0x97244546, 0x14214f74, 0xbf8b8840, 0x4d95fc1d, 0x96b591af, 0x70f4ddd3, 0x66a02f45, 0xbfbc09ec, 0x03bd9785, 0x7fac6dd0, 0x31cb8504, 0x96eb27b3, 0x55fd3941, 0xda2547e6, 0xabca0a9a, 0x28507825, 0x530429f4, 0x0a2c86da, 0xe9b66dfb, 0x68dc1462, 0xd7486900, 0x680ec0a4, 0x27a18dee, 0x4f3ffea2, 0xe887ad8c, 0xb58ce006, 0x7af4d6b6, 0xaace1e7c, 0xd3375fec, 0xce78a399, 0x406b2a42, 0x20fe9e35, 0xd9f385b9, 0xee39d7ab, 0x3b124e8b, 0x1dc9faf7, 0x4b6d1856, 0x26a36631, 0xeae397b2, 0x3a6efa74, 0xdd5b4332, 0x6841e7f7, 0xca7820fb, 0xfb0af54e, 0xd8feb397, 0x454056ac, 0xba489527, 0x55533a3a, 0x20838d87, 0xfe6ba9b7, 0xd096954b,
    0x55a867bc, 0xa1159a58, 0xcca92963, 0x99e1db33, 0xa62a4a56, 0x3f3125f9, 0x5ef47e1c, 0x9029317c, 0xfdf8e802, 0x04272f70, 0x80bb155c, 0x05282ce3, 0x95c11548, 0xe4c66d22, 0x48c1133f, 0xc70f86dc, 0x07f9c9ee, 0x41041f0f, 0x404779a4, 0x5d886e17, 0x325f51eb, 0xd59bc0d1, 0xf2bcc18f, 0x41113564, 0x257b7834, 0x602a9c60, 0xdff8e8a3, 0x1f636c1b, 0x0e12b4c2, 0x02e1329e, 0xaf664fd1, 0xcad18115, 0x6b2395e0, 0x333e92e1, 0x3b240b62, 0xeebeb922, 0x85b2a20e, 0xe6ba0d99, 0xde720c8c, 0x2da2f728, 0xd0127845, 0x95b794fd, 0x647d0862, 0xe7ccf5f0, 0x5449a36f, 0x877d48fa, 0xc39dfd27, 0xf33e8d1e, 0x0a476341, 0x992eff74, 0x3a6f6eab, 0xf4f8fd37, 0xa812dc60, 0xa1ebddf8, 0x991be14c, 0xdb6e6b0d, 0xc67b5510, 0x6d672c37, 0x2765d43b, 0xdcd0e804, 0xf1290dc7, 0xcc00ffa3, 0xb5390f92, 0x690fed0b,
    0x667b9ffb, 0xcedb7d9c, 0xa091cf0b, 0xd9155ea3, 0xbb132f88, 0x515bad24, 0x7b9479bf, 0x763bd6eb, 0x37392eb3, 0xcc115979, 0x8026e297, 0xf42e312d, 0x6842ada7, 0xc66a2b3b, 0x12754ccc, 0x782ef11c, 0x6a124237, 0xb79251e7, 0x06a1bbe6, 0x4bfb6350, 0x1a6b1018, 0x11caedfa, 0x3d25bdd8, 0xe2e1c3c9, 0x44421659, 0x0a121386, 0xd90cec6e, 0xd5abea2a, 0x64af674e, 0xda86a85f, 0xbebfe988, 0x64e4c3fe, 0x9dbc8057, 0xf0f7c086, 0x60787bf8, 0x6003604d, 0xd1fd8346, 0xf6381fb0, 0x7745ae04, 0xd736fccc, 0x83426b33, 0xf01eab71, 0xb0804187, 0x3c005e5f, 0x77a057be, 0xbde8ae24, 0x55464299, 0xbf582e61, 0x4e58f48f, 0xf2ddfda2, 0xf474ef38, 0x8789bdc2, 0x5366f9c3, 0xc8b38e74, 0xb475f255, 0x46fcd9b9, 0x7aeb2661, 0x8b1ddf84, 0x846a0e79, 0x915f95e2, 0x466e598e, 0x20b45770, 0x8cd55591, 0xc902de4c,
    0xb90bace1, 0xbb8205d0, 0x11a86248, 0x7574a99e, 0xb77f19b6, 0xe0a9dc09, 0x662d09a1, 0xc4324633, 0xe85a1f02, 0x09f0be8c, 0x4a99a025, 0x1d6efe10, 0x1ab93d1d, 0x0ba5a4df, 0xa186f20f, 0x2868f169, 0xdcb7da83, 0x573906fe, 0xa1e2ce9b, 0x4fcd7f52, 0x50115e01, 0xa70683fa, 0xa002b5c4, 0x0de6d027, 0x9af88c27, 0x773f8641, 0xc3604c06, 0x61a806b5, 0xf0177a28, 0xc0f586e0, 0x006058aa, 0x30dc7d62, 0x11e69ed7, 0x2338ea63, 0x53c2dd94, 0xc2c21634, 0xbbcbee56, 0x90bcb6de, 0xebfc7da1, 0xce591d76, 0x6f05e409, 0x4b7c0188, 0x39720a3d, 0x7c927c24, 0x86e3725f, 0x724d9db9, 0x1ac15bb4, 0xd39eb8fc, 0xed545578, 0x08fca5b5, 0xd83d7cd3, 0x4dad0fc4, 0x1e50ef5e, 0xb161e6f8, 0xa28514d9, 0x6c51133c, 0x6fd5c7e7, 0x56e14ec4, 0x362abfce, 0xddc6c837, 0xd79a3234, 0x92638212, 0x670efa8e, 0x406000e0,
  ];

  // S-box 3 initialization vector (hex digits of pi).
  // prettier-ignore
  static readonly KS3: number[] = [
    0x3a39ce37, 0xd3faf5cf, 0xabc27737, 0x5ac52d1b, 0x5cb0679e, 0x4fa33742, 0xd3822740, 0x99bc9bbe, 0xd5118e9d, 0xbf0f7315, 0xd62d1c7e, 0xc700c47b, 0xb78c1b6b, 0x21a19045, 0xb26eb1be, 0x6a366eb4, 0x5748ab2f, 0xbc946e79, 0xc6a376d2, 0x6549c2c8, 0x530ff8ee, 0x468dde7d, 0xd5730a1d, 0x4cd04dc6, 0x2939bbdb, 0xa9ba4650, 0xac9526e8, 0xbe5ee304, 0xa1fad5f0, 0x6a2d519a, 0x63ef8ce2, 0x9a86ee22, 0xc089c2b8, 0x43242ef6, 0xa51e03aa, 0x9cf2d0a4, 0x83c061ba, 0x9be96a4d, 0x8fe51550, 0xba645bd6, 0x2826a2f9, 0xa73a3ae1, 0x4ba99586, 0xef5562e9, 0xc72fefd3, 0xf752f7da, 0x3f046f69, 0x77fa0a59, 0x80e4a915, 0x87b08601, 0x9b09e6ad, 0x3b3ee593, 0xe990fd5a, 0x9e34d797, 0x2cf0b7d9, 0x022b8b51, 0x96d5ac3a, 0x017da67d, 0xd1cf3ed6, 0x7c7d2d28, 0x1f9f25cf, 0xadf2b89b, 0x5ad6b472, 0x5a88f54c,
    0xe029ac71, 0xe019a5e6, 0x47b0acfd, 0xed93fa9b, 0xe8d3c48d, 0x283b57cc, 0xf8d56629, 0x79132e28, 0x785f0191, 0xed756055, 0xf7960e44, 0xe3d35e8c, 0x15056dd4, 0x88f46dba, 0x03a16125, 0x0564f0bd, 0xc3eb9e15, 0x3c9057a2, 0x97271aec, 0xa93a072a, 0x1b3f6d9b, 0x1e6321f5, 0xf59c66fb, 0x26dcf319, 0x7533d928, 0xb155fdf5, 0x03563482, 0x8aba3cbb, 0x28517711, 0xc20ad9f8, 0xabcc5167, 0xccad925f, 0x4de81751, 0x3830dc8e, 0x379d5862, 0x9320f991, 0xea7a90c2, 0xfb3e7bce, 0x5121ce64, 0x774fbe32, 0xa8b6e37e, 0xc3293d46, 0x48de5369, 0x6413e680, 0xa2ae0810, 0xdd6db224, 0x69852dfd, 0x09072166, 0xb39a460a, 0x6445c0dd, 0x586cdecf, 0x1c20c8ae, 0x5bbef7dd, 0x1b588d40, 0xccd2017f, 0x6bb4e3bb, 0xdda26a7e, 0x3a59ff45, 0x3e350a44, 0xbcb4cdd5, 0x72eacea8, 0xfa6484bb, 0x8d6612ae, 0xbf3c6f47,
    0xd29be463, 0x542f5d9e, 0xaec2771b, 0xf64e6370, 0x740e0d8d, 0xe75b1357, 0xf8721671, 0xaf537d5d, 0x4040cb08, 0x4eb4e2cc, 0x34d2466a, 0x0115af84, 0xe1b00428, 0x95983a1d, 0x06b89fb4, 0xce6ea048, 0x6f3f3b82, 0x3520ab82, 0x011a1d4b, 0x277227f8, 0x611560b1, 0xe7933fdc, 0xbb3a792b, 0x344525bd, 0xa08839e1, 0x51ce794b, 0x2f32c9b7, 0xa01fbac9, 0xe01cc87e, 0xbcc7d1f6, 0xcf0111c3, 0xa1e8aac7, 0x1a908749, 0xd44fbd9a, 0xd0dadecb, 0xd50ada38, 0x0339c32a, 0xc6913667, 0x8df9317c, 0xe0b12b4f, 0xf79e59b7, 0x43f5bb3a, 0xf2d519ff, 0x27d9459c, 0xbf97222c, 0x15e6fc2a, 0x0f91fc71, 0x9b941525, 0xfae59361, 0xceb69ceb, 0xc2a86459, 0x12baa8d1, 0xb6c1075e, 0xe3056a0c, 0x10d25065, 0xcb03a442, 0xe0ec6e0e, 0x1698db3b, 0x4c98a0be, 0x3278e964, 0x9f1f9532, 0xe0d392df, 0xd3a0342b, 0x8971f21e,
    0x1b0a7441, 0x4ba3348c, 0xc5be7120, 0xc37632d8, 0xdf359f8d, 0x9b992f2e, 0xe60b6f47, 0x0fe3f11d, 0xe54cda54, 0x1edad891, 0xce6279cf, 0xcd3e7e6f, 0x1618b166, 0xfd2c1d05, 0x848fd2c5, 0xf6fb2299, 0xf523f357, 0xa6327623, 0x93a83531, 0x56cccd02, 0xacf08162, 0x5a75ebb5, 0x6e163697, 0x88d273cc, 0xde966292, 0x81b949d0, 0x4c50901b, 0x71c65614, 0xe6c6c7bd, 0x327a140a, 0x45e1d006, 0xc3f27b9a, 0xc9aa53fd, 0x62a80f00, 0xbb25bfe2, 0x35bdd2f6, 0x71126905, 0xb2040222, 0xb6cbcf7c, 0xcd769c2b, 0x53113ec0, 0x1640e3d3, 0x38abbd60, 0x2547adf0, 0xba38209c, 0xf746ce76, 0x77afa1c5, 0x20756060, 0x85cbfe4e, 0x8ae88dd8, 0x7aaaf9b0, 0x4cf9aa7e, 0x1948c25c, 0x02fb8a8c, 0x01c36ae4, 0xd6ebe1f9, 0x90d4f869, 0xa65cdea0, 0x3f09252d, 0xc208e69f, 0xb74e6132, 0xce77e25b, 0x578fdfe3, 0x3ac372e6,
  ];

  static readonly ROUNDS = 16; // number of Feistel rounds
  static readonly BLOCK_SIZE = 8; // 64-bit block
  static readonly SBOX_SK = 256; // entries per S-box
  static readonly P_SZ = BlowfishEngine.ROUNDS + 2; // 18 P-array entries

  S0: number[];
  S1: number[];
  S2: number[];
  S3: number[];
  P: number[];

  constructor() {
    this.S0 = new Array<number>(BlowfishEngine.SBOX_SK);
    this.S1 = new Array<number>(BlowfishEngine.SBOX_SK);
    this.S2 = new Array<number>(BlowfishEngine.SBOX_SK);
    this.S3 = new Array<number>(BlowfishEngine.SBOX_SK);
    this.P = new Array<number>(BlowfishEngine.P_SZ);
  }

  // Initialize the engine with a key, then run the key schedule.
  init(key: Uint8Array): void {
    this.setKey(key);
  }

  // Key schedule: seed S-boxes/P-array from pi, XOR the P-array with key material,
  // then iteratively encrypt to derive the final subkeys and S-boxes.
  setKey(key: Uint8Array): void {
    for (let i = 0; i < BlowfishEngine.SBOX_SK; i++) {
      this.S0[i] = BlowfishEngine.KS0[i]!;
      this.S1[i] = BlowfishEngine.KS1[i]!;
      this.S2[i] = BlowfishEngine.KS2[i]!;
      this.S3[i] = BlowfishEngine.KS3[i]!;
    }
    for (let i = 0; i < BlowfishEngine.P_SZ; i++) {
      this.P[i] = BlowfishEngine.KP[i]!;
    }

    const keyLength = key.byteLength;
    let keyIndex = 0;
    for (let i = 0; i < BlowfishEngine.P_SZ; i++) {
      let data = 0x00000000;
      for (let j = 0; j < 4; j++) {
        data = (data << 8) | (key[keyIndex++]! & 0xff);
        if (keyIndex >= keyLength) keyIndex = 0;
      }
      this.P[i]! ^= data;
    }

    this.processTable(0, 0, this.P);
    this.processTable(
      this.P[BlowfishEngine.P_SZ - 2]!,
      this.P[BlowfishEngine.P_SZ - 1]!,
      this.S0,
    );
    this.processTable(
      this.S0[BlowfishEngine.SBOX_SK - 2]!,
      this.S0[BlowfishEngine.SBOX_SK - 1]!,
      this.S1,
    );
    this.processTable(
      this.S1[BlowfishEngine.SBOX_SK - 2]!,
      this.S1[BlowfishEngine.SBOX_SK - 1]!,
      this.S2,
    );
    this.processTable(
      this.S2[BlowfishEngine.SBOX_SK - 2]!,
      this.S2[BlowfishEngine.SBOX_SK - 1]!,
      this.S3,
    );
  }

  // Fill a table (P-array or an S-box) by repeatedly encrypting the running (xl, xr) pair.
  processTable(xl: number, xr: number, table: number[]): void {
    const size = table.length;
    for (let s = 0; s < size; s += 2) {
      xl = this.xor(xl, this.P[0]!);
      for (let i = 1; i < BlowfishEngine.ROUNDS; i += 2) {
        xr = this.xor(xr, this.xor(this.F(xl), this.P[i]!));
        xl = this.xor(xl, this.xor(this.F(xr), this.P[i + 1]!));
      }
      xr = this.xor(xr, this.P[BlowfishEngine.ROUNDS + 1]!);
      table[s] = xr;
      table[s + 1] = xl;
      xr = xl;
      xl = table[s]!;
    }
  }

  // Feistel function: F(x) = ((S0[a] + S1[b]) XOR S2[c]) + S3[d], a..d are the 4 bytes of x.
  F(x: number): number {
    return (
      ((this.S0[x >>> 24]! + this.S1[(x >>> 16) & 0xff]!) ^
        this.S2[(x >>> 8) & 0xff]!) +
      this.S3[x & 0xff]!
    );
  }

  getBlockSize(): number {
    return BlowfishEngine.BLOCK_SIZE;
  }

  // Encrypt one 8-byte block from src[srcIndex..] into dst[dstIndex..].
  encryptBlock(
    src: Uint8Array,
    srcIndex: number,
    dst: Uint8Array,
    dstIndex: number,
  ): void {
    let xl = this.bytesTo32Bits(src, srcIndex);
    let xr = this.bytesTo32Bits(src, srcIndex + 4);
    xl ^= this.P[0]!;
    for (let i = 1; i < BlowfishEngine.ROUNDS; i += 2) {
      xr ^= this.F(xl) ^ this.P[i]!;
      xl ^= this.F(xr) ^ this.P[i + 1]!;
    }
    xr ^= this.P[BlowfishEngine.ROUNDS + 1]!;
    this.bits32ToBytes(xr, dst, dstIndex);
    this.bits32ToBytes(xl, dst, dstIndex + 4);
  }

  // Decrypt one 8-byte block from src[srcIndex..] into dst[dstIndex..].
  decryptBlock(
    src: Uint8Array,
    srcIndex: number,
    dst: Uint8Array,
    dstIndex: number,
  ): void {
    let xl = this.bytesTo32Bits(src, srcIndex);
    let xr = this.bytesTo32Bits(src, srcIndex + 4);
    xl ^= this.P[BlowfishEngine.ROUNDS + 1]!;
    for (let i = BlowfishEngine.ROUNDS; i > 0; i -= 2) {
      xr ^= this.F(xl) ^ this.P[i]!;
      xl ^= this.F(xr) ^ this.P[i - 1]!;
    }
    xr ^= this.P[0]!;
    this.bits32ToBytes(xr, dst, dstIndex);
    this.bits32ToBytes(xl, dst, dstIndex + 4);
  }

  signedToUnsigned(signed: number): number {
    return signed >>> 0;
  }

  xor(a: number, b: number): number {
    return this.signedToUnsigned(a ^ b);
  }

  // Read 4 bytes as a little-endian 32-bit unsigned integer.
  bytesTo32Bits(b: Uint8Array, i: number): number {
    return this.signedToUnsigned(
      ((b[i + 3]! & 0xff) << 24) |
        ((b[i + 2]! & 0xff) << 16) |
        ((b[i + 1]! & 0xff) << 8) |
        (b[i]! & 0xff),
    );
  }

  // Write a 32-bit integer as 4 little-endian bytes.
  bits32ToBytes(inb: number, b: Uint8Array, offset: number): void {
    b[offset] = inb;
    b[offset + 1] = inb >> 8;
    b[offset + 2] = inb >> 16;
    b[offset + 3] = inb >> 24;
  }
}

// ECB wrappers — the only Blowfish entry points used by the rest of the project.
// Data length MUST be a multiple of 8 (no padding). Each 8-byte block is processed independently.
export function blowfishEncrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length % BlowfishEngine.BLOCK_SIZE !== 0)
    throw new Error("Blowfish ECB: data length must be a multiple of 8");
  const engine = new BlowfishEngine();
  engine.init(key);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += BlowfishEngine.BLOCK_SIZE) {
    engine.encryptBlock(data, i, out, i);
  }
  return out;
}
export function blowfishDecrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length % BlowfishEngine.BLOCK_SIZE !== 0)
    throw new Error("Blowfish ECB: data length must be a multiple of 8");
  const engine = new BlowfishEngine();
  engine.init(key);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += BlowfishEngine.BLOCK_SIZE) {
    engine.decryptBlock(data, i, out, i);
  }
  return out;
}
```

### `src/crypto/NewCrypt.ts` (checksum + rolling XOR)

```typescript
export const NewCrypt = {
  // XOR of every 4-byte LE word; written into the last 4 bytes before the trailing pad.
  appendChecksum(raw: Uint8Array): void {
    const size = raw.length;
    let chk = 0,
      i = 0;
    for (i = 0; i < size - 4; i += 4) {
      const w =
        raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16) | (raw[i + 3] << 24);
      chk ^= w;
    }
    raw[i] = chk & 0xff;
    raw[i + 1] = (chk >>> 8) & 0xff;
    raw[i + 2] = (chk >>> 16) & 0xff;
    raw[i + 3] = (chk >>> 24) & 0xff;
  },

  // Reverse rolling-XOR pass used only when decrypting the Init packet.
  decXORPass(raw: Uint8Array, key: number): void {
    const size = raw.length;
    let pos = size - 12;
    let ecx = key;
    while (4 <= pos) {
      let edx =
        raw[pos] |
        (raw[pos + 1] << 8) |
        (raw[pos + 2] << 16) |
        (raw[pos + 3] << 24);
      edx ^= ecx;
      ecx -= edx;
      ecx = ecx & 0xffffffff;
      raw[pos] = edx & 0xff;
      raw[pos + 1] = (edx >>> 8) & 0xff;
      raw[pos + 2] = (edx >>> 16) & 0xff;
      raw[pos + 3] = (edx >>> 24) & 0xff;
      pos -= 4;
    }
  },
};
```

### `src/crypto/ScrambledRsaKey.ts` (unscramble the 128-byte modulus)

```typescript
// The server scrambles the modulus; unscramble in this exact order before using it for RSA.
export function unscrambleModulus(scrambled: Buffer): Buffer {
  if (scrambled.length !== 128)
    throw new Error(`RSA modulus must be 128 bytes, got ${scrambled.length}`);
  const n = Buffer.from(scrambled);
  for (let i = 0; i < 0x40; i++) n[0x40 + i] ^= n[i]; // C^-1
  for (let i = 0; i < 4; i++) n[0x0d + i] ^= n[0x34 + i]; // B^-1
  for (let i = 0; i < 0x40; i++) n[i] ^= n[0x40 + i]; // A^-1
  for (let i = 0; i < 4; i++) {
    const t = n[i];
    n[i] = n[0x4d + i];
    n[0x4d + i] = t;
  } // D^-1 swap
  return n;
}
```

### `src/crypto/RsaCrypt.ts` (encrypt credentials, RSA-1024, NO_PADDING)

```typescript
import { createPublicKey, publicEncrypt, constants } from "node:crypto";

// Plaintext is exactly 128 bytes: login at offset 0x5E (14 bytes), password at 0x6E (16 bytes).
function buildPlaintext(login: string, password: string): Buffer {
  const p = Buffer.alloc(128, 0);
  Buffer.from(login.slice(0, 14), "ascii").copy(p, 0x5e);
  Buffer.from(password.slice(0, 16), "ascii").copy(p, 0x6e);
  return p;
}

function derLen(len: number): number[] {
  if (len < 128) return [len];
  if (len < 256) return [0x81, len];
  return [0x82, (len >> 8) & 0xff, len & 0xff];
}

// Build a PKCS#1 DER public key from a raw modulus + exponent 65537.
function buildDer(modulus: Buffer): Buffer {
  const e = Buffer.from([0x01, 0x00, 0x01]); // 65537
  const m =
    modulus[0] & 0x80 ? Buffer.concat([Buffer.from([0]), modulus]) : modulus;
  const mInt = Buffer.concat([Buffer.from([0x02, ...derLen(m.length)]), m]);
  const eInt = Buffer.concat([Buffer.from([0x02, ...derLen(e.length)]), e]);
  const inner = Buffer.concat([mInt, eInt]);
  return Buffer.concat([Buffer.from([0x30, ...derLen(inner.length)]), inner]);
}

export function encryptCredentials(
  login: string,
  password: string,
  modulus: Buffer,
): Buffer {
  const der = buildDer(modulus);
  const key = createPublicKey({ key: der, format: "der", type: "pkcs1" });
  return Buffer.from(
    publicEncrypt(
      { key, padding: constants.RSA_NO_PADDING },
      buildPlaintext(login, password),
    ),
  );
}
```

### `src/crypto/LoginCrypt.ts` (login packet enc/dec)

```typescript
import { blowfishEncrypt, blowfishDecrypt } from "./Blowfish";
import { NewCrypt } from "./NewCrypt";

const STATIC_KEY = Buffer.from([
  0x6b, 0x60, 0xcb, 0x5b, 0x82, 0xce, 0x90, 0xb1, 0xcc, 0x2b, 0x6c, 0x55, 0x6c,
  0x6c, 0x6c, 0x6c,
]);

export class LoginCrypt {
  private key: Buffer = STATIC_KEY;
  private hasSession = false;
  setSessionKey(blowfishKey: Buffer): void {
    this.key = blowfishKey;
    this.hasSession = true;
  }
  // Init packet: static-key Blowfish decrypt → reverse rolling XOR → drop trailing 8 bytes.
  decryptInit(body: Buffer): Buffer {
    const raw = new Uint8Array(blowfishDecrypt(body, STATIC_KEY));
    const size = raw.length;
    const xor =
      raw[size - 8] |
      (raw[size - 7] << 8) |
      (raw[size - 6] << 16) |
      (raw[size - 5] << 24);
    NewCrypt.decXORPass(raw, xor);
    return Buffer.from(raw).subarray(0, size - 8);
  }
  // All packets after Init.
  decrypt(body: Buffer): Buffer {
    if (!this.hasSession) return body;
    return blowfishDecrypt(body, this.key);
  }
  // Outgoing after session key set: pad to 4, add 8 zero bytes, pad to 8, checksum, encrypt.
  encrypt(body: Buffer): Buffer {
    if (!this.hasSession) return body;
    let buf = Buffer.from(body);
    if (buf.length % 4 !== 0)
      buf = Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]);
    buf = Buffer.concat([buf, Buffer.alloc(8)]);
    if (buf.length % 8 !== 0)
      buf = Buffer.concat([buf, Buffer.alloc(8 - (buf.length % 8))]);
    const raw = new Uint8Array(buf);
    NewCrypt.appendChecksum(raw);
    return blowfishEncrypt(Buffer.from(raw), this.key);
  }
}
```

> The simplest correct approach: after decoding Init, call `setSessionKey(blowfishKeyFromInit)` and
> use `encrypt()` for **all** outgoing login packets (including RequestGGAuth). The session key from
> Init is what the server expects for every client→server login packet.

### `src/crypto/GameCrypt.ts` (game-server 16-byte shifting XOR — HighFive)

```typescript
// HighFive game-server 16-byte shifting XOR cipher. Key = 8-byte XOR key from CryptInit +
// fixed static tail. Enabled only when the CryptInit flag is non-zero; see HARD CONSTRAINTS #7.
const STATIC_TAIL = Buffer.from([
  0xc8, 0x27, 0x93, 0x01, 0xa1, 0x6c, 0x31, 0x97,
]);

export class GameCrypt {
  private keyIn = Buffer.alloc(16); // server -> client
  private keyOut = Buffer.alloc(16); // client -> server
  private enabled = false;
  init(xorKey: Buffer, enable: boolean): void {
    const full = Buffer.alloc(16);
    xorKey.subarray(0, 8).copy(full, 0);
    STATIC_TAIL.copy(full, 8);
    this.keyIn = Buffer.from(full);
    this.keyOut = Buffer.from(full);
    this.enabled = enable;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  decrypt(data: Buffer): Buffer {
    if (!this.enabled) return data;
    const out = Buffer.from(data);
    const size = out.length;
    let xor = 0;
    for (let i = 0; i < size; i++) {
      const enc = out[i] & 0xff;
      out[i] = (enc ^ this.keyIn[i & 15] ^ xor) & 0xff;
      xor = enc;
    }
    this.shift(this.keyIn, size);
    return out;
  }

  encrypt(data: Buffer): Buffer {
    if (!this.enabled) return data;
    const out = Buffer.from(data);
    const size = out.length;
    let enc = 0;
    for (let i = 0; i < size; i++) {
      enc = ((out[i] & 0xff) ^ this.keyOut[i & 15] ^ enc) & 0xff;
      out[i] = enc;
    }
    this.shift(this.keyOut, size);
    return out;
  }

  // Advance bytes 8..11 of the key (little-endian uint32) by the packet size.
  private shift(key: Buffer, size: number): void {
    let v = key[8] | (key[9] << 8) | (key[10] << 16) | (key[11] << 24);
    v = (v + size) >>> 0;
    key[8] = v & 0xff;
    key[9] = (v >>> 8) & 0xff;
    key[10] = (v >>> 16) & 0xff;
    key[11] = (v >>> 24) & 0xff;
  }
}
```

> **Wiring:** after CryptInit call `gameCrypt.init(xorKey, flag !== 0)` and apply it as described in
> HARD CONSTRAINTS #7. ProtocolVersion is sent raw before CryptInit.

### `src/debug/DebugTools.ts` (self-debug toolkit) — COPY VERBATIM

Copy this module as-is; only its imports may need path tweaks to match your `src/` layout.
It depends on **nothing but `src/types.ts`**, so create it together with the scaffold, before the
crypto modules exist. The `modulus is 128 bytes` and `charCount >= 1` checks are `check(...)` calls
made from the FSM code during the socket phase — they feed the same counters and that is expected.

```typescript
import type { Artifacts } from "../types";

let passed = 0;
let failed = 0;

// Truthy cond -> "[ok] name" and passed++. Falsy -> "[FAIL] name" and failed++.
export function check(name: string, cond: unknown): boolean {
  if (cond) {
    console.log(`[ok] ${name}`);
    passed += 1;
    return true;
  }
  console.log(`[FAIL] ${name}`);
  failed += 1;
  return false;
}

export function selfTestCounts(): { passed: number; failed: number } {
  return { passed, failed };
}

export function logState(from: string, to: string): void {
  console.log(`[STATE] ${from} -> ${to}`);
}

export function assertState<T>(actual: T, expected: T, ctx: string): void {
  if (actual !== expected) {
    throw new Error(`bad state in ${ctx}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// The single final report. status is PASS only when nothing failed and no error was passed in.
export function report(statePath: string[], artifacts: Artifacts, notes?: string): void {
  const total = passed + failed;
  const status = failed === 0 && !notes ? "PASS" : "FAIL";
  const arts = Object.entries(artifacts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log("=== REPORT ===");
  console.log(`status: ${status}`);
  console.log(`self-tests: ${passed}/${total}`);
  console.log(`state-path: ${statePath.join(" -> ")}`);
  console.log(`artifacts: ${arts}`);
  console.log(`notes: ${notes ?? ""}`);
}

export const DebugTools = { check, selfTestCounts, logState, assertState, report };
```

### `src/crypto/selfTests.ts` (crypto self-tests) — COPY VERBATIM

Run **both** functions once at startup, **before any socket I/O**. They live next to the crypto they
exercise and report through `check(...)`, so they feed the same counters the final report prints.

```typescript
import { blowfishEncrypt, blowfishDecrypt } from "./Blowfish";
import { LoginCrypt } from "./LoginCrypt";
import { GameCrypt } from "./GameCrypt";
import { check } from "../debug/DebugTools";

export function runLoginCryptoSelfTests(): void {
  const key = Buffer.from("0123456789abcdef", "ascii"); // 16 bytes
  const block = Buffer.from("deadbeefdeadbeef", "ascii"); // 8 bytes
  check(
    "blowfish round-trip",
    blowfishDecrypt(blowfishEncrypt(block, key), key).equals(block),
  );

  const lc = new LoginCrypt();
  lc.setSessionKey(key);
  const body = Buffer.from([0x07, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const restored = lc.decrypt(lc.encrypt(body));
  check("logincrypt round-trip", restored.subarray(0, body.length).equals(body));
}

export function runGameCryptoSelfTests(): void {
  const xorKey = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 8-byte key from CryptInit

  const a = new GameCrypt();
  const b = new GameCrypt();
  a.init(xorKey, true);
  b.init(xorKey, true);
  const m1 = Buffer.from([0x2b, 0x10, 0x20, 0x30, 0x40, 0x50]);
  check("game-xor round-trip", b.decrypt(a.encrypt(Buffer.from(m1))).equals(m1));
  const m2 = Buffer.from([0x11, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  check(
    "game-xor round-trip (2nd packet)",
    b.decrypt(a.encrypt(Buffer.from(m2))).equals(m2),
  );

  const c = new GameCrypt();
  c.init(xorKey, false);
  const m3 = Buffer.from([0xaa, 0xbb, 0xcc]);
  check("game-xor disabled passthrough", c.encrypt(Buffer.from(m3)).equals(m3));
}
```

Final report format printed by `report(...)`:

```
=== REPORT ===
status: PASS | FAIL
self-tests: <passed>/<total>
state-path: IDLE -> ... -> <final>
artifacts: <key=value session data>
notes: <first failing assertion / error, if any>
```

The `state-path` is the happy path used for reporting; it may still include states that the
server skipped (e.g., `WAIT_LOGIN_OK` when `GGAuth` is skipped). Run
`runLoginCryptoSelfTests()` + `runGameCryptoSelfTests()` (imported from `crypto/selfTests`) once at
startup, **before any socket
I/O**. Also `check('modulus is 128 bytes', unscrambledModulus.length === 128)` once you have
the modulus and `check('charCount >= 1', charCount >= 1)` after CharSelectInfo. **If any
self-test fails, stop and print the report** — do not open sockets with broken crypto.

---

## MODULE CONTRACTS

The exact exported surface each module must expose. Wire the modules to these signatures so
cross-module calls typecheck on the first `tsc` pass. **Shared types come only from
`src/types.ts`; `login/` and `game/` never import from each other.**

| Module | Exports (signature) |
| ------ | ------------------- |
| `types.ts` | `Config`, `LoginResult`, `GameInput`, `Artifacts`, `LoginState`, `GameState`, `AnyState` (see the verbatim listing) |
| `config.ts` | `loadConfig(): Config` — reads `.env` via `dotenv`, `parseInt` numbers, throws a clear `Error` on any missing/invalid var |
| `crypto/Blowfish.ts` | `blowfishEncrypt(data: Buffer, key: Buffer): Buffer`, `blowfishDecrypt(data: Buffer, key: Buffer): Buffer` |
| `crypto/NewCrypt.ts` | `NewCrypt` object: `appendChecksum(raw: Uint8Array): void`, `decXORPass(raw: Uint8Array, key: number): void` |
| `crypto/ScrambledRsaKey.ts` | `unscrambleModulus(scrambled: Buffer): Buffer` |
| `crypto/RsaCrypt.ts` | `encryptCredentials(login: string, password: string, modulus: Buffer): Buffer` |
| `crypto/LoginCrypt.ts` | `class LoginCrypt` — `setSessionKey(k: Buffer): void`, `decryptInit(body: Buffer): Buffer`, `decrypt(body: Buffer): Buffer`, `encrypt(body: Buffer): Buffer` |
| `crypto/GameCrypt.ts` | `class GameCrypt` — `init(xorKey: Buffer, enable: boolean): void`, `isEnabled(): boolean`, `decrypt(data: Buffer): Buffer`, `encrypt(data: Buffer): Buffer` |
| `crypto/selfTests.ts` | `runLoginCryptoSelfTests(): void`, `runGameCryptoSelfTests(): void` (verbatim) |
| `game/Opcodes.ts` | `OPCODES` (`as const`), `ExtendedOpcode`, `ServerExtendedOpcode` |
| `net/Connection.ts` | `class Connection` (verbatim) — `send(body: Buffer): void` prepends the length itself |
| `net/PacketReader.ts` | `class PacketReader` (verbatim) |
| `net/PacketWriter.ts` | `class PacketWriter` (verbatim) |
| `debug/DebugTools.ts` | `check`, `selfTestCounts`, `logState`, `assertState`, `report` (verbatim); imports only `src/types.ts` |
| `login/LoginClient.ts` | `runLogin(cfg: Config, statePath: string[]): Promise<LoginResult>` |
| `game/GameClient.ts` | `runGame(cfg: Config, input: GameInput, statePath: string[]): Promise<Artifacts>` |
| `index.ts` | `main(): Promise<void>` (invoked at module load); owns the shared `statePath: string[]` |

---

## PROTOCOL REFERENCE (field-by-field)

Field types: `C`=uint8 (1), `H`=uint16LE (2), `D`=int32LE (4), `Q`=int64LE (8), `S`=UTF-16LE
null-terminated string, `b[n]`=`n` raw bytes.

### PART A — LOGIN SERVER

Flow: `Init → RequestGGAuth → GGAuth → RequestAuthLogin → LoginOk → RequestServerList →
ServerList → RequestServerLogin → PlayOk`.

`LoginClient` FSM states: `WAIT_INIT → WAIT_GG_AUTH → WAIT_LOGIN_OK → WAIT_SERVER_LIST →
WAIT_PLAY_OK`. Log every transition via `logState` and guard handlers with `assertState`.

**Init (← `0x00`)** — first packet, special crypto (`LoginCrypt.decryptInit`). After decrypt, read:

| Off | Type   | Field                                                 |
| --- | ------ | ----------------------------------------------------- |
| 0   | C      | opcode `0x00`                                         |
| 1   | D      | sessionId                                             |
| 5   | D      | protocol revision                                     |
| 9   | b[128] | scrambled RSA modulus → run `unscrambleModulus`       |
| 137 | b[16]  | unknown (skip)                                        |
| 153 | b[16]  | **Blowfish session key** → `LoginCrypt.setSessionKey` |

**RequestGGAuth (→ `0x07`)**: `C 0x07` + `D sessionId` + `b[16]` GG constants
(`0x00000123, 0x00004567, 0x000089AB, 0x0000CDEF` as four `D`) + `b[19]` zeros. Some servers skip
GGAuth; if you receive `LoginOk`-shaped data instead, use `ggResponse = 0`.

**GGAuth (← `0x0B`)**: `C 0x0B` + `D response` (keep `response`).

**RequestAuthLogin (→ `0x00`)**: `C 0x00` + `b[128]` = `encryptCredentials(username, password,
unscrambledModulus)` + `D ggResponse` + the fixed 43-byte GG block:

```
23 01 00 00 67 45 00 00 ab 89 00 00 ef cd 00 00 08 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

**LoginOk (← `0x03`)**: `C 0x03` + `D loginOkId1` + `D loginOkId2`. (`LoginFail 0x01` + `C reason`
means stop.)

**RequestServerList (→ `0x05`)**: `C 0x05` + `D loginOkId1` + `D loginOkId2` + `D 0x04000000`.

**ServerList (← `0x04`)**: `C 0x04` + `C serverCount` + `C 0x00`, then `serverCount` records:
`C id` + `b[4] ip` + `D port` + `C ageLimit` + `C pvp` + `H online` + `H maxPlayers` +
`C status` + `D 0` + `C 0`. Pick the record where `id == L2_SERVER_ID`.

**RequestServerLogin (→ `0x02`)**: `C 0x02` + `D loginOkId1` + `D loginOkId2` + `C serverId`.

**PlayOk (← `0x07`)**: `C 0x07` + `D playOkId1` + `D playOkId2`. (`PlayFail 0x06` means stop.)

**Carry forward to the game stage:** `loginOkId1`, `loginOkId2`, `playOkId1`, `playOkId2`, and the game
server host/port. Then close the login connection.

### PART B — GAME SERVER (flag-driven 16-byte shifting XOR)

> Connect to the game host/port. ProtocolVersion is sent raw; after CryptInit apply game encryption
> per HARD CONSTRAINTS #7.

Flow: `→ ProtocolVersion | CryptInit ← | → AuthRequest | CharSelectInfo ← | → CharacterSelected |
CharSelected ← | → RequestKeyMapping + EnterWorld | UserInfo ← ⇒ IN_GAME | (loop) ping/pong`.

`GameClient` FSM states: `WAIT_CRYPT_INIT → WAIT_CHAR_LIST → WAIT_CHAR_SELECTED →
WAIT_USER_INFO → IN_GAME`. Log every transition via `logState` and guard handlers with
`assertState`. Tolerate up to 10 unknown packets in `WAIT_CHAR_SELECTED` and `WAIT_USER_INFO`;
silently drop all non-ping packets once `IN_GAME`.

**ProtocolVersion (→ `0x0E`)**: `C 0x0E` + `D L2_PROTOCOL`. Sent immediately on connect, **raw**
(no game encryption yet).

**CryptInit (← `0x2E`)** — first packet from server. `C 0x2E` + `C status` + `b[8] xorKey` +
`D encryptionFlag` + rest. Call `gameCrypt.init(xorKey, encryptionFlag !== 0)` and apply encryption
per HARD CONSTRAINTS #7. This packet body itself is unencrypted.

**AuthRequest (→ `0x2B`)** — encrypted only when the CryptInit flag was non-zero (see HARD CONSTRAINTS
#7): `C 0x2B` + `S username` + `D playOkId2` + `D playOkId1` + `D loginOkId1` + `D loginOkId2`.
HighFive has no trailing language field.

**CharSelectInfo (← `0x09`)**: `C 0x09` + `D charCount` + per-character data. You only need to
confirm `charCount >= 1`. Log the count.

**CharacterSelected (→ `0x12`)**: `C 0x12` + `D L2_CHAR_SLOT` + `b[14]` zeros.
(The 14 zero bytes are required.)

**CharSelected confirm (← `0x0B`)**: just the opcode (and char details you can ignore). Some servers
skip this and jump straight to UserInfo — handle both: if you receive the UserInfo opcode (`0x32`)
while waiting for the confirm, proceed as if confirmed.

**EnterWorld sequence (→):** send `RequestKeyMapping` as the extended packet `0xD0 0x0021`, then
`EnterWorld 0x11` + `b[104]` zeros (the 104 zero bytes are mandatory).

**UserInfo (← `0x32`)**: the character is now in the world. **Print `IN_GAME`.** You don't need to
parse its fields for this task.

**Keepalive — NetPingRequest (← `0xD3` or `0xFE 0x00D3`) / NetPing pong (→ `0xA8`):** once you
reach `WAIT_USER_INFO` (and later `IN_GAME`), whenever you receive opcode `0xD3`
(`C 0xD3` + `D pingId`) or the server-extended form `0xFE 0x00D3`
(`C 0xFE` + `H 0x00D3` + `D pingId`), reply with NetPing:
`C 0xA8` + `D pingId` + `D 0x00000000` + `D 0x00080000`. Keep the process alive.

---

## TROUBLESHOOTING (common failure modes)

- **Blowfish decodes as garbage / round-trip fails.** Verify
  `blowfishDecrypt(blowfishEncrypt(x, k), k).equals(x)` before any socket I/O. Use pure TypeScript
  (no `node:crypto`), 8-byte blocks, ECB, no padding.
- **Init won't decode.** Static-key Blowfish decrypt → `decXORPass` → drop the last 8 bytes. No
  checksum on Init.
- **LoginFail right after AuthLogin.** RSA: unscramble modulus, use `RSA_NO_PADDING`, 128-byte
  plaintext with login at `0x5E` and password at `0x6E` (ASCII).
- **Checksum mismatch / server drops you on login.** Outgoing login packets: pad to 4 bytes, append
  8 zero bytes, pad to 8, write the XOR checksum into the 4 bytes before the final pad, then
  Blowfish-encrypt. Length prefix is measured on the encrypted body.
- **Wrong opcodes / nothing happens on the game server.** You used the textbook L2 opcodes. Use the
  HighFive OPCODE MAP exactly (ProtocolVersion `0x0E`, CryptInit `0x2E`, AuthRequest `0x2B`, …).
- **AuthRequest rejected.** Key order is `playOkId2, playOkId1, loginOkId1, loginOkId2`. No trailing
  language field.
- **CharacterSelected ignored.** You must append exactly 14 zero bytes after the slot index.
- **No UserInfo after EnterWorld / silent disconnect.** You forgot the 104 bytes of padding, or you
  skipped RequestKeyMapping. HighFive enter-world = RequestKeyMapping (`0xD0 0x0021`) then EnterWorld
  `0x11` + `b[104]` zeros.
- **Game packets look scrambled.** Verify `gameCrypt.init(xorKey, flag !== 0)` and
  `decrypt(encrypt(x)).equals(x)`. Static key tail: `c8 27 93 01 a1 6c 31 97`. See HARD CONSTRAINTS
  #7 for flag behavior.
- **Connection closes after a minute.** You aren't answering pings. Reply to every `0xD3` (and the
  server-extended `0xFE 0x00D3`) with the 13-byte `0xA8` pong.
- **`send()` writes garbage / server rejects frames.** `Connection.send(body)` expects the body
  WITHOUT the 2-byte length prefix and prepends it internally. Do not prepend the length yourself.
- **Duplicate EnterWorld warning.** If `UserInfo` arrives before `CharSelected`, guard the enter-world
  sequence so it runs at most once.
- **Connection closes before `UserInfo`.** If the server closes the socket while the
  client is still in `WAIT_USER_INFO`, treat it as a failure: settle the promise (reject it
  or resolve with an error — never leave it pending) and print the report with `status: FAIL`.

---

## FINAL DELIVERABLE

A complete, compiling project. Running `npm run dev` with a valid `.env` connects end-to-end,
prints `IN_GAME`, and keeps answering pings. The program prints its self-debug report. No extra
features.
