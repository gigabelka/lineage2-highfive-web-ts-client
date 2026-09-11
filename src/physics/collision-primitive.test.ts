import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import buildTriangleIndex from "./triangle-index";
import { queryPrimitive, sweptBounds, sweptIntersectsBox } from "./collision-primitive";
import type { CollisionPrimitive_T } from "@client/objects/objects";
import { Matrix4 } from "three";

// One XY-aligned quad at z = 0, two triangles, spanning (0,0)..(100,100).
const quadVertices = new Float32Array([
    0, 0, 0,
    100, 0, 0,
    100, 100, 0,
    0, 100, 0
]);
const quadIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);

function makeTerrainPrimitive(): CollisionPrimitive_T<"terrain"> {
    return {
        kind: "terrain",
        vertices: quadVertices,
        indices: quadIndices,
        index: buildTriangleIndex(quadVertices, quadIndices),
        matrixWorld: new Matrix4(),
        bounds: new Box3(new Vector3(0, 0, 0), new Vector3(100, 100, 0)),
        supportsZeroExtent: true,
        supportsNonZeroExtent: true,
        supportsPointCheck: true
    };
}

describe("buildTriangleIndex", () => {
    it("buckets every triangle at least once", () => {
        const index = buildTriangleIndex(quadVertices, quadIndices);
        const seen = new Set<number>();

        for (let cell = 0; cell < index.sizeX * index.sizeY; cell++)
            for (let i = index.offsets[cell]; i < index.offsets[cell + 1]; i++)
                seen.add(index.triangleIndices[i]);

        expect(index.offsets.length).toBe(index.sizeX * index.sizeY + 1);
        expect(index.marks.length).toBe(quadIndices.length / 3);
        expect([...seen].sort()).toEqual([0, 1]);
    });

    it("covers the source extents", () => {
        const index = buildTriangleIndex(quadVertices, quadIndices);

        expect(index.minX).toBe(0);
        expect(index.minY).toBe(0);
        expect(index.cellSizeX * index.sizeX).toBeCloseTo(100);
        expect(index.cellSizeY * index.sizeY).toBeCloseTo(100);
    });
});

describe("sweptBounds / sweptIntersectsBox", () => {
    const extent = new Vector3(10, 10, 20);

    it("inflates the segment AABB by the extent", () => {
        const target = sweptBounds(new Vector3(0, 0, 0), new Vector3(50, -30, 5), extent, new Box3());

        expect(target.min.toArray()).toEqual([-10, -40, -20]);
        expect(target.max.toArray()).toEqual([60, 10, 25]);
    });

    it("hits a box the swept extent grazes but the segment misses", () => {
        const bounds = new Box3(new Vector3(40, 15, -5), new Vector3(60, 25, 5));

        // extent inflates the BOX, so y=0 must fall inside [15 - 10, 25 + 10]

        expect(sweptIntersectsBox(new Vector3(0, 0, 0), new Vector3(100, 0, 0), new Vector3(), bounds)).toBe(false);
        expect(sweptIntersectsBox(new Vector3(0, 0, 0), new Vector3(100, 0, 0), new Vector3(10, 20, 20), bounds)).toBe(true);
    });

    it("rejects a box behind the segment", () => {
        const bounds = new Box3(new Vector3(-500, -5, -5), new Vector3(-400, 5, 5));

        expect(sweptIntersectsBox(new Vector3(0, 0, 0), new Vector3(100, 0, 0), extent, bounds)).toBe(false);
    });
});

describe("queryPrimitive (terrain)", () => {
    it("stops a downward zero-extent trace on the quad", () => {
        const hit = queryPrimitive(makeTerrainPrimitive(), new Vector3(50, 50, 100), new Vector3(50, 50, -100), new Vector3());

        expect(hit).not.toBeNull();
        expect(hit.time).toBeCloseTo(0.5, 5);
        expect(hit.normal.z).toBeGreaterThan(0.99);
    });

    it("misses when the trace is outside the quad in XY", () => {
        const hit = queryPrimitive(makeTerrainPrimitive(), new Vector3(500, 500, 100), new Vector3(500, 500, -100), new Vector3());

        expect(hit).toBeNull();
    });

    it("stops a box trace one half-height earlier than a ray", () => {
        // every hit is the same pooled PrimitiveHit_T, so read `.time` before the next query
        const rayTime = queryPrimitive(makeTerrainPrimitive(), new Vector3(50, 50, 100), new Vector3(50, 50, -100), new Vector3()).time;
        const boxHit = queryPrimitive(makeTerrainPrimitive(), new Vector3(50, 50, 100), new Vector3(50, 50, -100), new Vector3(10, 10, 20));

        expect(boxHit).not.toBeNull();
        expect(boxHit.time).toBeLessThan(rayTime);
        expect(boxHit.time).toBeCloseTo(0.4, 5); // 100 -> 20 over a 200-unit sweep
    });
});
