import { describe, expect, it } from "vitest";

import { TILE_SIZE, TILE_ZERO_X, TILE_ZERO_Y, coordToTile } from "@client/net/world-tile";

describe("coordToTile", () => {
  it("maps the client's own debug spawn to its tile", () => {
    // render-manager.ts:741 hardcoded player spawn, in the Cruma area
    expect(coordToTile(13584.5, 114414.37).id).toBe("20_21");
  });

  it("maps the near-church debug coordinates to 17_25", () => {
    // render-manager.ts:734, in the file's (x, y, z) order - the tile exists as maps/17_25.unr
    expect(coordToTile(-84272.02, 245391.89).id).toBe("17_25");
  });

  it("puts the world origin on the retail zero tile", () => {
    expect(coordToTile(0, 0)).toEqual({ sx: 20, sy: 18, id: "20_18" });
  });

  it("floors toward negative infinity rather than truncating toward zero", () => {
    // -1 must land in the tile BELOW the origin, which a Math.trunc would get wrong
    expect(coordToTile(-1, -1)).toEqual({ sx: 19, sy: 17, id: "19_17" });
  });

  it("handles exact tile boundaries", () => {
    expect(coordToTile(-TILE_ZERO_X * TILE_SIZE, -TILE_ZERO_Y * TILE_SIZE)).toEqual({
      sx: 0,
      sy: 0,
      id: "0_0",
    });

    expect(coordToTile(TILE_SIZE, TILE_SIZE).id).toBe("21_19");
    expect(coordToTile(TILE_SIZE - 1, TILE_SIZE - 1).id).toBe("20_18");
  });

  /* RenderManager.getSectorId carries its own copy of this formula on the per-frame streaming
     path. The two must never drift, so the client's version is replicated here and compared. */
  it("agrees with RenderManager.getSectorId's formula", () => {
    const getSectorId = (x: number, y: number): [number, number] => {
      const sectorSize = 256 * 128;
      return [Math.floor(x / sectorSize) + 20, Math.floor(y / sectorSize) + 18];
    };

    const samples = [
      [0, 0],
      [13584.5, 114414.37],
      [-84272.02, 245391.89],
      [-294912, -262144],
      [229375, 294911],
      [-1, 1],
      [32767.9, -32768],
    ];

    for (const [x, y] of samples) {
      const [sx, sy] = getSectorId(x, y);
      expect(coordToTile(x, y)).toEqual({ sx, sy, id: `${sx}_${sy}` });
    }
  });

  it("keeps the server's world bounds inside the retail tile range", () => {
    // World.java: WORLD_X_MIN -294912 .. WORLD_X_MAX 229376, TILE_X_MIN 11 .. TILE_X_MAX 26
    expect(coordToTile(-294912, -262144)).toMatchObject({ sx: 11, sy: 10 });
    expect(coordToTile(229375, 294911)).toMatchObject({ sx: 26, sy: 26 });
  });
});
