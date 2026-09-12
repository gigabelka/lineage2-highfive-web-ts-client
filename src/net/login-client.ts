/**
 * Login-server state machine.
 *
 * Flow (server-protocol.md PART A, verified against loginserver/network/serverpackets/*.java):
 *   Init -> RequestGGAuth -> GGAuth -> RequestAuthLogin -> LoginOk -> RequestServerList ->
 *   ServerList -> RequestServerLogin -> PlayOk
 *
 * Resolves with the four session ids plus the game host/port, then closes its own connection.
 * `game-client.ts` never imports this file and vice versa; `LoginResult` is the whole contract.
 */

import type { NetConfig } from "@client/net/config";
import PacketReader from "@client/net/binary/packet-reader";
import PacketWriter from "@client/net/binary/packet-writer";
import { L2Connection } from "@client/net/ws-transport";
import { LoginCrypt } from "@client/net/crypto/login-crypt";
import { OPCODES, describeLoginFail } from "@client/net/opcodes";
import { encryptCredentials } from "@client/net/crypto/rsa-crypt";
import { hex } from "@client/net/binary/bytes";
import { unscrambleModulus } from "@client/net/crypto/scrambled-rsa-key";

/** Set `globalThis.__L2_TRACE = true` to dump every decrypted login body. Read lazily: a
 *  module-level const would be evaluated before the flag is ever set. */
function tracing(): boolean {
  return Boolean((globalThis as { __L2_TRACE?: boolean }).__L2_TRACE);
}

export type LoginState =
  | "WAIT_INIT"
  | "WAIT_GG_AUTH"
  | "WAIT_LOGIN_OK"
  | "WAIT_SERVER_LIST"
  | "WAIT_PLAY_OK"
  | "DONE"
  | "FAILED";

export interface LoginResult {
  loginOkId1: number;
  loginOkId2: number;
  playOkId1: number;
  playOkId2: number;
  gameHost: string;
  gamePort: number;
}

/** The fixed 43-byte GG block that follows the RSA blob in RequestAuthLogin. */
const GG_TAIL = new Uint8Array([
  0x23, 0x01, 0x00, 0x00, 0x67, 0x45, 0x00, 0x00, 0xab, 0x89, 0x00, 0x00, 0xef, 0xcd, 0x00, 0x00,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

interface ServerRecord {
  id: number;
  host: string;
  port: number;
  online: number;
  maxPlayers: number;
  up: boolean;
}

/**
 * A LAN L2J-Mobius advertises whatever is in its ipconfig.xml, very often `127.0.0.1` - which is
 * the BROWSER's loopback, not the server's. L2_LOGIN_IP is the address that demonstrably routes,
 * so fall back to it; likewise prefer the configured game port over the advertised one.
 */
export function resolveGameHost(advertised: string, cfg: NetConfig): string {
  const unroutable = advertised.startsWith("127.") || advertised === "0.0.0.0" || advertised === "";
  return unroutable ? cfg.loginHost : advertised;
}

export function runLogin(cfg: NetConfig, onState?: (state: LoginState) => void): Promise<LoginResult> {
  return new Promise<LoginResult>((resolve, reject) => {
    const crypt = new LoginCrypt();

    let state: LoginState = "WAIT_INIT";
    let connection: L2Connection | null = null;
    let settled = false;

    let sessionId = 0;
    let modulus: Uint8Array = new Uint8Array(0);
    let ggResponse = 0;
    let loginOkId1 = 0;
    let loginOkId2 = 0;

    const transition = (next: LoginState): void => {
      console.info(`[login] ${state} -> ${next}`);
      state = next;
      onState?.(next);
    };

    const finish = (result: LoginResult): void => {
      if (settled) return;
      settled = true;
      transition("DONE");
      connection?.close();
      resolve(result);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      transition("FAILED");
      connection?.close();
      reject(new Error(message));
    };

    const send = (body: Uint8Array): void => connection?.send(crypt.encrypt(body));

    const handleInit = (body: Uint8Array): void => {
      const r = new PacketReader(crypt.decryptInit(body));

      r.skip(1); // opcode 0x00
      sessionId = r.readInt32LE();

      const revision = r.readInt32LE() >>> 0;
      const scrambled = r.readBytes(128);

      r.skip(16); // unknown
      const blowfishKey = r.readBytes(16);

      modulus = unscrambleModulus(scrambled);

      if (modulus.length !== 128) return fail(`RSA modulus is ${modulus.length} bytes, expected 128`);

      /* From Init.java the session key is what every subsequent client->server login packet is
         encrypted with, RequestGGAuth included. */
      crypt.setSessionKey(blowfishKey);

      console.info(
        `[login] Init: sessionId=0x${(sessionId >>> 0).toString(16)} revision=0x${revision.toString(16)}`,
      );

      transition("WAIT_GG_AUTH");

      send(
        new PacketWriter(OPCODES.login.out.RequestGGAuth)
          .writeInt32LE(sessionId)
          .writeInt32LE(0x00000123)
          .writeInt32LE(0x00004567)
          .writeInt32LE(0x000089ab)
          .writeInt32LE(0x0000cdef)
          .writeZeros(19)
          .toBytes(),
      );
    };

    const sendAuthLogin = (): void => {
      transition("WAIT_LOGIN_OK");

      send(
        new PacketWriter(OPCODES.login.out.RequestAuthLogin)
          .writeBytes(encryptCredentials(cfg.username, cfg.password, modulus))
          .writeInt32LE(ggResponse)
          .writeBytes(GG_TAIL)
          .toBytes(),
      );
    };

    const handleLoginOk = (r: PacketReader): void => {
      loginOkId1 = r.readInt32LE();
      loginOkId2 = r.readInt32LE();

      transition("WAIT_SERVER_LIST");

      send(
        new PacketWriter(OPCODES.login.out.RequestServerList)
          .writeInt32LE(loginOkId1)
          .writeInt32LE(loginOkId2)
          .writeInt32LE(0x04000000)
          .toBytes(),
      );
    };

    const handleServerList = (r: PacketReader): void => {
      const count = r.readUInt8();

      r.skip(1); // last-used server id

      const servers: ServerRecord[] = [];

      for (let i = 0; i < count; i++) {
        const id = r.readUInt8();
        const ip = r.readBytes(4);
        const port = r.readInt32LE();
        const ageLimit = r.readUInt8();
        const pvp = r.readUInt8();
        const online = r.readUInt16LE();
        const maxPlayers = r.readUInt16LE();
        const status = r.readUInt8();

        r.skipInt32(1); // server type
        r.skip(1); // brackets

        void ageLimit;
        void pvp;

        servers.push({
          id,
          host: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`,
          port,
          online,
          maxPlayers,
          up: status !== 0,
        });
      }

      console.info(
        `[login] ServerList: ${servers.map((s) => `#${s.id} ${s.host}:${s.port} ${s.online}/${s.maxPlayers}${s.up ? "" : " DOWN"}`).join(", ")}`,
      );

      const chosen = servers.find((s) => s.id === cfg.serverId);

      if (!chosen) {
        return fail(
          `L2_SERVER_ID=${cfg.serverId} is not in the server list (ids: ${servers.map((s) => s.id).join(", ") || "none"})`,
        );
      }

      const gameHost = resolveGameHost(chosen.host, cfg);
      const gamePort = cfg.gamePort;

      console.info(
        `[login] game host ${gameHost}:${gamePort} (advertised ${chosen.host}:${chosen.port})`,
      );

      transition("WAIT_PLAY_OK");

      send(
        new PacketWriter(OPCODES.login.out.RequestServerLogin)
          .writeInt32LE(loginOkId1)
          .writeInt32LE(loginOkId2)
          .writeUInt8(cfg.serverId)
          .toBytes(),
      );

      pendingGameHost = gameHost;
      pendingGamePort = gamePort;
    };

    let pendingGameHost = "";
    let pendingGamePort = 0;

    const onPacket = (raw: Uint8Array): void => {
      if (settled) return;

      try {
        if (state === "WAIT_INIT") return handleInit(raw);

        const body = crypt.decrypt(raw);

        if (tracing()) {
          console.info(`[login] ${state} raw=${raw.length} dec=${body.length}: ${hex(body, 32)}`);
        }

        const r = new PacketReader(body);
        const opcode = r.readUInt8();

        if (opcode === OPCODES.login.in.LoginFail) {
          return fail(`LoginFail: ${describeLoginFail(r.readUInt8())}`);
        }

        if (opcode === OPCODES.login.in.PlayFail && state === "WAIT_PLAY_OK") {
          return fail(`PlayFail: ${describeLoginFail(r.readUInt8())}`);
        }

        switch (state) {
          case "WAIT_GG_AUTH":
            if (opcode === OPCODES.login.in.GGAuth) {
              ggResponse = r.readInt32LE();
              return sendAuthLogin();
            }

            /* Some servers skip GGAuth entirely and answer with LoginOk-shaped data; in that
               case ggResponse stays 0 and we fall straight through (server-protocol.md PART A). */
            if (opcode === OPCODES.login.in.LoginOk) {
              console.info("[login] GGAuth skipped by the server, ggResponse=0");
              transition("WAIT_LOGIN_OK");
              return handleLoginOk(r);
            }

            break;

          case "WAIT_LOGIN_OK":
            if (opcode === OPCODES.login.in.LoginOk) return handleLoginOk(r);
            break;

          case "WAIT_SERVER_LIST":
            if (opcode === OPCODES.login.in.ServerList) return handleServerList(r);
            break;

          case "WAIT_PLAY_OK":
            // PlayOk and RequestGGAuth share 0x07, but only one direction reaches this switch.
            if (opcode === OPCODES.login.in.PlayOk) {
              return finish({
                loginOkId1,
                loginOkId2,
                playOkId1: r.readInt32LE(),
                playOkId2: r.readInt32LE(),
                gameHost: pendingGameHost,
                gamePort: pendingGamePort,
              });
            }

            break;

          default:
            break;
        }

        console.warn(
          `[login] ignored opcode 0x${opcode.toString(16).padStart(2, "0")} in ${state} (${body.length} bytes: ${hex(body, 16)})`,
        );
      } catch (e) {
        fail(`login packet handling failed in ${state}: ${(e as Error).message}`);
      }
    };

    L2Connection.open(cfg.loginHost, cfg.loginPort, {
      onPacket,
      onClose: (reason) => {
        if (!settled) fail(`login server closed the connection in ${state} (${reason})`);
      },
      onError: (error) => fail(`login connection error in ${state}: ${error.message}`),
    })
      .then((c) => {
        connection = c;
        onState?.(state); // the server speaks first here; nothing to send on connect
      })
      .catch((e: Error) => fail(e.message));
  });
}

export default runLogin;
