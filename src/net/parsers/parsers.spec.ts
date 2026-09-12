import { describe, expect, it } from "vitest";

import PacketWriter from "@client/net/binary/packet-writer";
import { parseCharSelected } from "@client/net/parsers/char-selected";
import { parseCharSelectionInfo } from "@client/net/parsers/char-selection-info";
import { parseUserInfo } from "@client/net/parsers/user-info";

interface FakeChar {
  name: string;
  objectId: number;
  x: number;
  y: number;
  z: number;
  level: number;
  classId: number;
  active: boolean;
}

/**
 * Writes one CharSelectionInfo record in the exact order of
 * gameserver/network/serverpackets/CharSelectionInfo.java. Written independently of the parser
 * so the two must agree on the layout rather than on a shared helper - an off-by-one in either
 * shifts the second record and fails the two-character case below.
 */
function writeCharRecord(w: PacketWriter, c: FakeChar, account: string): void {
  w.writeStringNullUTF16(c.name);
  w.writeInt32LE(c.objectId);
  w.writeStringNullUTF16(account);
  w.writeInt32LE(0x1234); // sessionId
  w.writeInt32LE(0); // clanId
  w.writeInt32LE(0); // builder level
  w.writeInt32LE(1); // sex
  w.writeInt32LE(0); // race
  w.writeInt32LE(c.classId); // base class id
  w.writeInt32LE(1); // GameServerName

  w.writeInt32LE(c.x);
  w.writeInt32LE(c.y);
  w.writeInt32LE(c.z);

  w.writeDoubleLE(500.5); // current HP
  w.writeDoubleLE(200.25); // current MP
  w.writeInt32LE(77); // sp
  w.writeInt64LE(123456789n); // exp
  w.writeDoubleLE(0.42); // exp percent
  w.writeInt32LE(c.level);
  w.writeInt32LE(0); // karma
  w.writeInt32LE(0); // pk kills
  w.writeInt32LE(0); // pvp kills

  for (let i = 0; i < 7; i++) w.writeInt32LE(0);
  for (let i = 0; i < 26; i++) w.writeInt32LE(1000 + i); // paperdoll

  w.writeInt32LE(3); // hair style
  w.writeInt32LE(2); // hair colour
  w.writeInt32LE(1); // face
  w.writeDoubleLE(600); // max HP
  w.writeDoubleLE(300); // max MP
  w.writeInt32LE(0); // delete timer
  w.writeInt32LE(c.classId);
  w.writeInt32LE(c.active ? 1 : 0);
  w.writeUInt8(12); // enchant effect
  w.writeInt32LE(0); // augmentation id
  w.writeInt32LE(0); // transform id

  for (let i = 0; i < 4; i++) w.writeInt32LE(0); // pet npc id / level / food / food level

  w.writeDoubleLE(0); // pet HP
  w.writeDoubleLE(0); // pet MP
  w.writeInt32LE(140); // vitality points
}

function buildCharSelectionInfo(chars: FakeChar[], maxChars = 7): Uint8Array {
  const w = new PacketWriter(0x09);

  w.writeInt32LE(chars.length);
  w.writeInt32LE(maxChars);
  w.writeUInt8(0);

  for (const c of chars) writeCharRecord(w, c, "qwerty");

  return w.toBytes();
}

const HERO: FakeChar = {
  name: "Qwerty",
  objectId: 268476032,
  x: -84272,
  y: 245391,
  z: -3730,
  level: 42,
  classId: 88,
  active: true,
};

const SECOND: FakeChar = {
  name: "Второй",
  objectId: 268476033,
  x: 13584,
  y: 114414,
  z: -3472,
  level: 1,
  classId: 0,
  active: false,
};

describe("parseCharSelectionInfo", () => {
  it("reads the header fields the doc omits", () => {
    const { chars, maxChars } = parseCharSelectionInfo(buildCharSelectionInfo([HERO], 7));

    expect(chars).toHaveLength(1);
    expect(maxChars).toBe(7);
  });

  it("reads name and coordinates of a single character", () => {
    const { chars } = parseCharSelectionInfo(buildCharSelectionInfo([HERO]));

    expect(chars[0]).toEqual({
      slot: 0,
      name: "Qwerty",
      objectId: 268476032,
      classId: 88,
      level: 42,
      x: -84272,
      y: 245391,
      z: -3730,
      active: true,
    });
  });

  /* The record walk is the fragile part: a single wrong skip shifts everything after the first
     record, so a two-character list is what actually proves the stride. */
  it("walks a whole record to reach the second one", () => {
    const { chars } = parseCharSelectionInfo(buildCharSelectionInfo([HERO, SECOND]));

    expect(chars).toHaveLength(2);
    expect(chars[0].name).toBe("Qwerty");
    expect(chars[1]).toMatchObject({
      slot: 1,
      name: "Второй",
      objectId: 268476033,
      x: 13584,
      y: 114414,
      z: -3472,
      level: 1,
      active: false,
    });
  });

  it("consumes the buffer exactly, with nothing left over", () => {
    const body = buildCharSelectionInfo([HERO, SECOND]);
    // A trailing byte would mean the parser stopped short; a throw would mean it overran.
    expect(() => parseCharSelectionInfo(body)).not.toThrow();
    expect(() => parseCharSelectionInfo(body.subarray(0, body.length - 1))).toThrow(RangeError);
  });

  it("handles an empty character list", () => {
    const { chars } = parseCharSelectionInfo(buildCharSelectionInfo([]));
    expect(chars).toHaveLength(0);
  });
});

describe("parseUserInfo", () => {
  it("reads x, y, z straight after the opcode", () => {
    const body = new PacketWriter(0x32)
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .writeInt32LE(0) // vehicle object id
      .writeInt32LE(268476032)
      .writeStringNullUTF16("Qwerty")
      .writeInt32LE(0) // race - proof that we stop before it
      .toBytes();

    expect(parseUserInfo(body)).toEqual({
      x: -84272,
      y: 245391,
      z: -3730,
      objectId: 268476032,
      name: "Qwerty",
    });
  });

  it("throws on a truncated packet rather than reporting 0,0,0", () => {
    expect(() => parseUserInfo(new Uint8Array([0x32, 1, 2]))).toThrow(RangeError);
  });
});

describe("parseCharSelected", () => {
  it("reads name and coordinates", () => {
    const body = new PacketWriter(0x0b)
      .writeStringNullUTF16("Qwerty")
      .writeInt32LE(268476032)
      .writeStringNullUTF16("") // title
      .writeInt32LE(0x1234) // sessionId
      .writeInt32LE(0) // clanId
      .writeInt32LE(0)
      .writeInt32LE(1) // isFemale
      .writeInt32LE(0) // race
      .writeInt32LE(88) // classId
      .writeInt32LE(1) // active
      .writeInt32LE(-84272)
      .writeInt32LE(245391)
      .writeInt32LE(-3730)
      .toBytes();

    expect(parseCharSelected(body)).toEqual({
      name: "Qwerty",
      objectId: 268476032,
      classId: 88,
      x: -84272,
      y: 245391,
      z: -3730,
    });
  });
});
