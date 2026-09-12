/**
 * World coordinate -> map tile.
 *
 * Server world coordinates map 1:1 onto the client's UE2 world space, and both sides use the
 * same tile grid:
 *   - server: gameserver/model/World.java - TILE_SIZE 32768, TILE_ZERO_COORD_X 20, TILE_ZERO_COORD_Y 18
 *   - client: RenderManager.getSectorId - floor(x / (256 * 128)) + 20, floor(y / ...) + 18
 * The resulting `"17_25"` is also the base name of the `maps/17_25.unr` package.
 *
 * This module is the shared spec for that mapping and is three.js-free so it can be unit
 * tested; `getSectorId` keeps its own Vector3-based copy because it runs every frame.
 */

export const TILE_SIZE = 256 * 128; // 32768
export const TILE_ZERO_X = 20;
export const TILE_ZERO_Y = 18;

export interface WorldTile {
  sx: number;
  sy: number;
  /** The sector id string, which is also the .unr package base name. */
  id: string;
}

export function coordToTile(x: number, y: number): WorldTile {
  const sx = Math.floor(x / TILE_SIZE) + TILE_ZERO_X;
  const sy = Math.floor(y / TILE_SIZE) + TILE_ZERO_Y;

  return { sx, sy, id: `${sx}_${sy}` };
}

export default coordToTile;
