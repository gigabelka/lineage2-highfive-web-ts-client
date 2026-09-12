/**
 * Game-server state machine.
 *
 * Flow (server-protocol.md PART B, reconciled with the Java source):
 *   -> ProtocolVersion | CryptInit <- | -> AuthRequest | CharSelectionInfo <- |
 *   -> CharacterSelected | CharSelected <- | -> RequestKeyMapping + EnterWorld |
 *   UserInfo <- => IN_GAME | (loop) client ping / server pong
 *
 * Never imports login-client.ts; `GameInput` is the whole contract between the two stages.
 */

import type { NetConfig } from "@client/net/config";
import PacketReader from "@client/net/binary/packet-reader";
import PacketWriter, { extended } from "@client/net/binary/packet-writer";
import { GameCrypt } from "@client/net/crypto/game-crypt";
import { L2Connection } from "@client/net/ws-transport";
import { OPCODES, ServerExtendedOpcode } from "@client/net/opcodes";
import { hex } from "@client/net/binary/bytes";
import { parseCharSelected, type CharSelectedBrief } from "@client/net/parsers/char-selected";
import { parseCharSelectionInfo, type CharacterInfo } from "@client/net/parsers/char-selection-info";
import { parseUserInfo, type UserInfoBrief } from "@client/net/parsers/user-info";

export type GameState =
  | "WAIT_CRYPT_INIT"
  | "WAIT_CHAR_LIST"
  | "WAIT_CHAR_SELECTED"
  | "WAIT_USER_INFO"
  | "IN_GAME"
  | "FAILED";

export interface GameInput {
  loginOkId1: number;
  loginOkId2: number;
  playOkId1: number;
  playOkId2: number;
  gameHost: string;
  gamePort: number;
  username: string;
}

export interface GameClientEvents {
  onState?(state: GameState): void;
  /** Earliest coordinate hint - lets sector streaming start during the handshake. */
  onCharList?(chars: CharacterInfo[], selectedSlot: number): void;
  onCharSelected?(char: CharSelectedBrief): void;
  /** Authoritative coordinates: the character now exists in the world. */
  onUserInfo?(info: UserInfoBrief): void;
  onPong?(gameTime: number): void;
  onDisconnect?(reason: string): void;
}

function tracing(): boolean {
  return Boolean((globalThis as { __L2_TRACE?: boolean }).__L2_TRACE);
}

export class GameClient {
  private readonly cfg: NetConfig;
  private readonly input: GameInput;
  private readonly events: GameClientEvents;
  private readonly crypt = new GameCrypt();

  private connection: L2Connection | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private settled = false;
  private enteredWorld = false;
  private unknownCount = 0;

  private currentState: GameState = "WAIT_CRYPT_INIT";

  public constructor(cfg: NetConfig, input: GameInput, events: GameClientEvents) {
    this.cfg = cfg;
    this.input = input;
    this.events = events;
  }

  public get state(): GameState {
    return this.currentState;
  }

  /** Resolves once UserInfo arrives (IN_GAME); rejects on any handshake failure. */
  public start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (message: string): void => {
        if (this.settled) return;
        this.settled = true;
        this.transition("FAILED");
        this.stop();
        reject(new Error(message));
      };

      const reachedWorld = (): void => {
        if (this.settled) return;
        this.settled = true;
        this.transition("IN_GAME");
        this.startKeepalive();
        resolve();
      };

      L2Connection.open(this.input.gameHost, this.input.gamePort, {
        onPacket: (raw) => this.onPacket(raw, fail, reachedWorld),
        onClose: (reason) => {
          this.stopKeepalive();

          if (!this.settled) {
            /* Never leave the promise pending: a server that hangs up mid-handshake is the
               single most common failure and it must surface as a rejection, not a stall. */
            fail(`game server closed the connection in ${this.currentState} (${reason})`);
          } else {
            this.events.onDisconnect?.(reason);
          }
        },
        onError: (error) => {
          if (!this.settled) fail(`game connection error in ${this.currentState}: ${error.message}`);
          else this.events.onDisconnect?.(error.message);
        },
      })
        .then((connection) => {
          this.connection = connection;
          this.events.onState?.(this.currentState);

          // ProtocolVersion goes out raw - game encryption is not configured until CryptInit.
          connection.send(
            new PacketWriter(OPCODES.game.out.ProtocolVersion).writeInt32LE(this.cfg.protocol).toBytes(),
          );
        })
        .catch((e: Error) => fail(e.message));
    });
  }

  public stop(): void {
    this.stopKeepalive();
    this.connection?.close();
    this.connection = null;
  }

  private transition(next: GameState): void {
    console.info(`[game] ${this.currentState} -> ${next}`);
    this.currentState = next;
    this.events.onState?.(next);
  }

  private send(body: Uint8Array): void {
    this.connection?.send(this.crypt.encrypt(body));
  }

  private onPacket(raw: Uint8Array, fail: (m: string) => void, reachedWorld: () => void): void {
    try {
      // CryptInit itself is never encrypted; encryption starts with the packet after it.
      const body = this.currentState === "WAIT_CRYPT_INIT" ? raw : this.crypt.decrypt(raw);

      if (body.length === 0) return;

      if (tracing()) {
        console.info(`[game] ${this.currentState} <- ${body.length} bytes: ${hex(body, 24)}`);
      }

      const opcode = body[0];

      /* Server extended packets are 0xFE + a 2-byte LE sub-opcode. Nothing in the handshake
         needs one, but they arrive in bulk after CharSelected and must not be mistaken for
         plain opcodes. */
      if (opcode === ServerExtendedOpcode) {
        if (tracing() && body.length >= 3) {
          console.info(`[game] extended 0x${(body[1] | (body[2] << 8)).toString(16)} ignored`);
        }
        return;
      }

      if (opcode === OPCODES.game.in.NetPing) {
        const r = new PacketReader(body);
        r.skip(1);
        this.events.onPong?.(r.remaining() >= 4 ? r.readInt32LE() : 0);
        return;
      }

      switch (this.currentState) {
        case "WAIT_CRYPT_INIT":
          if (opcode === OPCODES.game.in.CryptInit) return this.handleCryptInit(body, fail);
          break;

        case "WAIT_CHAR_LIST":
          if (opcode === OPCODES.game.in.CharSelectionInfo) return this.handleCharList(body, fail);
          break;

        case "WAIT_CHAR_SELECTED":
          if (opcode === OPCODES.game.in.CharSelected) {
            this.handleCharSelected(body);
            return this.enterWorld();
          }

          /* Some servers skip the confirmation and jump straight to UserInfo. Treat that as
             confirmed, but only after the enter-world sequence has actually gone out. */
          if (opcode === OPCODES.game.in.UserInfo) {
            this.enterWorld();
            this.handleUserInfo(body);
            return reachedWorld();
          }

          break;

        case "WAIT_USER_INFO":
          if (opcode === OPCODES.game.in.UserInfo) {
            this.handleUserInfo(body);
            return reachedWorld();
          }

          break;

        case "IN_GAME":
          return; // everything but the pong is dropped once we are in the world

        default:
          return;
      }

      /* The server fires a torrent of packets between CharSelected and UserInfo (skills, items,
         quest state, ...). Counting them is useful; failing on them is not. */
      this.unknownCount += 1;

      if (this.unknownCount <= 20 || tracing()) {
        console.debug(
          `[game] ignored opcode 0x${opcode.toString(16).padStart(2, "0")} in ${this.currentState} (${body.length} bytes)`,
        );
      }
    } catch (e) {
      fail(`game packet handling failed in ${this.currentState}: ${(e as Error).message}`);
    }
  }

  /**
   * KeyPacket layout from gameserver/network/serverpackets/KeyPacket.java:
   * `C 0x2E, C result, b[8] xorKey, D PACKET_ENCRYPTION, D serverId, C 1, D 0`.
   * server-protocol.md stops after the flag.
   */
  private handleCryptInit(body: Uint8Array, fail: (m: string) => void): void {
    const r = new PacketReader(body);

    r.skip(1);

    const result = r.readUInt8();
    const xorKey = r.readBytes(8);
    const encryptionFlag = r.readInt32LE();
    const serverId = r.readInt32LE();

    if (result === 0) {
      return fail(`the server rejected protocol ${this.cfg.protocol} (KeyPacket result 0)`);
    }

    this.crypt.init(xorKey, encryptionFlag !== 0);

    console.info(
      `[game] CryptInit: serverId=${serverId} encryption=${encryptionFlag !== 0 ? "on" : "off (plaintext)"}`,
    );

    this.transition("WAIT_CHAR_LIST");

    /* Key order is playOkId2, playOkId1, loginOkId1, loginOkId2 - see AuthLogin.java readImpl.
       HighFive has no trailing language field. */
    this.send(
      new PacketWriter(OPCODES.game.out.AuthRequest)
        .writeStringNullUTF16(this.input.username)
        .writeInt32LE(this.input.playOkId2)
        .writeInt32LE(this.input.playOkId1)
        .writeInt32LE(this.input.loginOkId1)
        .writeInt32LE(this.input.loginOkId2)
        .toBytes(),
    );
  }

  private handleCharList(body: Uint8Array, fail: (m: string) => void): void {
    const { chars, maxChars } = parseCharSelectionInfo(body);

    console.info(
      `[game] CharSelectionInfo: ${chars.length}/${maxChars} - ${chars.map((c) => `[${c.slot}] ${c.name} lv${c.level} @ ${c.x},${c.y},${c.z}`).join("; ") || "none"}`,
    );

    if (chars.length === 0) {
      return fail("the account has no characters - create one in the retail client first");
    }

    if (this.cfg.charSlot >= chars.length) {
      return fail(`L2_CHAR_SLOT=${this.cfg.charSlot} but the account has only ${chars.length} character(s)`);
    }

    this.events.onCharList?.(chars, this.cfg.charSlot);

    this.transition("WAIT_CHAR_SELECTED");

    /* The 14 trailing zero bytes are mandatory: CharacterSelect.java reads
       `int slot, short, int, int, int` and the packet is dropped if they are missing. */
    this.send(
      new PacketWriter(OPCODES.game.out.CharacterSelected)
        .writeInt32LE(this.cfg.charSlot)
        .writeZeros(14)
        .toBytes(),
    );
  }

  private handleCharSelected(body: Uint8Array): void {
    try {
      const char = parseCharSelected(body);
      console.info(`[game] CharSelected: ${char.name} @ ${char.x},${char.y},${char.z}`);
      this.events.onCharSelected?.(char);
    } catch (e) {
      // A hint we failed to read is not worth losing the session over - UserInfo is what counts.
      console.warn(`[game] CharSelected parse failed, ignoring the coordinate hint: ${(e as Error).message}`);
    }
  }

  private handleUserInfo(body: Uint8Array): void {
    try {
      const info = parseUserInfo(body);
      console.info(`[game] UserInfo: ${info.name} @ ${info.x},${info.y},${info.z}`);
      this.events.onUserInfo?.(info);
    } catch (e) {
      console.error(`[game] UserInfo parse failed - coordinates unknown: ${(e as Error).message}`);
    }
  }

  /** RequestKeyMapping then EnterWorld, at most once even if UserInfo beat CharSelected. */
  private enterWorld(): void {
    if (this.enteredWorld) return;
    this.enteredWorld = true;

    this.transition("WAIT_USER_INFO");

    this.send(extended(OPCODES.game.out.RequestKeyMapping).toBytes());

    /* The 104 zero bytes are mandatory: EnterWorld.java reads b[32], 4 ints, b[32], int and
       five 4-byte tracert entries = 104. Skipping them (or RequestKeyMapping) is the classic
       "no UserInfo, silent disconnect". */
    this.send(new PacketWriter(OPCODES.game.out.EnterWorld).writeZeros(104).toBytes());
  }

  /**
   * CORRECTION vs server-protocol.md: on this server the CLIENT pings. RequestNetPing (0xB1,
   * empty body, IN_GAME only) is answered by NetPing (0xD9 + int gameTime). There is no
   * server-initiated 0xD3 and no 0xA8 pong to send. See opcodes.ts.
   */
  private startKeepalive(): void {
    this.stopKeepalive();

    this.pingTimer = setInterval(() => {
      if (!this.connection?.isOpen) return this.stopKeepalive();
      this.send(new PacketWriter(OPCODES.game.out.RequestNetPing).toBytes());
    }, this.cfg.pingMs);
  }

  private stopKeepalive(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export default GameClient;
