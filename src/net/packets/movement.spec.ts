import { describe, expect, it } from "vitest";

import PacketReader from "@client/net/binary/packet-reader";
import { OPCODES } from "@client/net/opcodes";
import { buildMoveToLocation, buildValidatePosition } from "@client/net/packets/movement";

describe("buildMoveToLocation", () => {
  it("writes opcode 0x0F followed by target then origin then movementMode, 29 bytes total", () => {
    const body = buildMoveToLocation({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 1);

    expect(body.length).toBe(1 + 7 * 4);
    expect(body[0]).toBe(OPCODES.game.out.MoveToLocation);
    expect(body[0]).toBe(0x0f);

    const r = new PacketReader(body);
    r.skip(1);
    expect(r.readInt32LE()).toBe(1); // targetX
    expect(r.readInt32LE()).toBe(2); // targetY
    expect(r.readInt32LE()).toBe(3); // targetZ
    expect(r.readInt32LE()).toBe(4); // originX
    expect(r.readInt32LE()).toBe(5); // originY
    expect(r.readInt32LE()).toBe(6); // originZ
    expect(r.readInt32LE()).toBe(1); // movementMode
    expect(r.remaining()).toBe(0);
  });

  it("rounds float coordinates", () => {
    const body = buildMoveToLocation({ x: 1.4, y: -2.6, z: 3.5 }, { x: 0, y: 0, z: 0 }, 0);
    const r = new PacketReader(body);
    r.skip(1);
    expect(r.readInt32LE()).toBe(1);
    expect(r.readInt32LE()).toBe(-3);
    expect(r.readInt32LE()).toBe(4);
  });
});

describe("buildValidatePosition", () => {
  it("writes opcode 0x59 followed by x, y, z, heading, vehicleId, 21 bytes total", () => {
    const body = buildValidatePosition({ x: 10, y: 20, z: 30 }, 40000, 0);

    expect(body.length).toBe(1 + 5 * 4);
    expect(body[0]).toBe(OPCODES.game.out.ValidatePosition);
    expect(body[0]).toBe(0x59);

    const r = new PacketReader(body);
    r.skip(1);
    expect(r.readInt32LE()).toBe(10);
    expect(r.readInt32LE()).toBe(20);
    expect(r.readInt32LE()).toBe(30);
    expect(r.readInt32LE()).toBe(40000);
    expect(r.readInt32LE()).toBe(0);
    expect(r.remaining()).toBe(0);
  });

  it("masks heading into the 0..65535 range", () => {
    const body = buildValidatePosition({ x: 0, y: 0, z: 0 }, -1);
    const r = new PacketReader(body);
    r.skip(1 + 3 * 4);
    expect(r.readInt32LE()).toBe(65535);
  });
});
