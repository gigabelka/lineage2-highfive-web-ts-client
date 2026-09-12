/**
 * HighFive (protocol 267) opcode map. Values are bytes unless noted.
 *
 * Base is the OPCODE MAP in server-protocol.md, but FOUR entries were reconciled against the
 * actual server source at c:\MyProjects\l2J-Mobius-CT-2.6-HighFive and the Java wins. Do not
 * "fix" these back to the document:
 *
 * 1. Keepalive is REVERSED and uses different opcodes. There is no server-initiated 0xD3 and no
 *    client 0xA8 on this server. The CLIENT sends RequestNetPing 0xB1 with an EMPTY payload
 *    (accepted only in state IN_GAME) and the server answers NetPing 0xD9 + int gameTime.
 *    Sources: gameserver/network/ClientPackets.java (NET_PING(0xB1)),
 *    gameserver/network/ServerPackets.java (NET_PING(0xD9)),
 *    gameserver/network/clientpackets/RequestNetPing.java (readImpl is empty),
 *    gameserver/network/serverpackets/NetPing.java.
 * 2. CharSelectionInfo (0x09) header carries two more fields than the doc lists - see
 *    parsers/char-selection-info.ts.
 * 3. CryptInit/KeyPacket (0x2E) has a longer body than the doc lists - see game-client.ts.
 * 4. UserInfo (0x32) puts x,y,z first, right after the opcode - see parsers/user-info.ts.
 *
 * A `const ... as const` object, never an `enum`: tsconfig has `isolatedModules`, and the login
 * halves collide by number anyway (RequestGGAuth and PlayOk are both 0x07), hence the in/out split.
 */
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
      CharSelectionInfo: 0x09,
      CharSelected: 0x0b,
      UserInfo: 0x32,
      NetPing: 0xd9, // CORRECTION 1: the server's ANSWER to our ping, not a request
    },
    out: {
      ProtocolVersion: 0x0e,
      AuthRequest: 0x2b,
      CharacterSelected: 0x12,
      RequestKeyMapping: 0x0021, // sent as the extended packet 0xD0 0x0021
      EnterWorld: 0x11,
      RequestNetPing: 0xb1, // CORRECTION 1: client-initiated, empty payload, IN_GAME only
    },
  },
} as const;

/** Client extended-packet prefix, followed by a 2-byte LE sub-opcode. */
export const ExtendedOpcode = 0xd0;

/** Server extended-packet prefix, likewise followed by a 2-byte LE sub-opcode. */
export const ServerExtendedOpcode = 0xfe;

/** LoginFail / PlayFail reason bytes, for a message a human can act on. */
export const LOGIN_FAIL_REASONS: Readonly<Record<number, string>> = {
  0x01: "system error",
  0x02: "invalid password",
  0x03: "invalid login or password",
  0x04: "access denied",
  0x05: "account info error",
  0x07: "account already in use",
  0x09: "account banned",
  0x10: "server overloaded",
  0x12: "subscription expired",
};

export function describeLoginFail(reason: number): string {
  return LOGIN_FAIL_REASONS[reason] ?? `reason 0x${reason.toString(16).padStart(2, "0")}`;
}

export default OPCODES;
