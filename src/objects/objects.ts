import type * as RAPIER from "@dimforge/rapier3d";
import type * as THREE from "three";

/**
 * Anything the physics/collision layer can see.
 *
 * The four original members (`isCollidable`, `createCollider`, `getCollider`, `getRigidbody`) stay
 * required so the pre-existing implementers (`MovableObject`, `RotatingObject`, `CollidingMesh`,
 * `Terrain`) keep compiling untouched. Everything added for the pawn/collision port is optional;
 * `CollisionWorld` and `PawnMovementComponent` feature-test each one.
 */
export interface ICollidable extends THREE.Object3D {
    readonly isCollidable: boolean;

    createCollider(physicsWorld: RAPIER.World): RAPIER.Collider;
    getCollider(): RAPIER.Collider;
    getRigidbody(): RAPIER.RigidBody;

    /** Drop cached Rapier handles after the world removed them; re-stream must rebuild. */
    releaseCollider?(): void;
    /** Multi-collider actors (BSP hull sets); defaults to `[getCollider()]`. */
    getColliders?(): RAPIER.Collider[];
    getCollisionProfile?(): ActorCollisionProfile_T;
    getCollisionPrimitive?(): CollisionPrimitive_T;
    /** Actor this one is standing on/riding (movers). */
    getBaseActor?(): ICollidable | null;
    getBasedActors?(): ReadonlySet<ICollidable>;
    addBasedActor?(actor: ICollidable): void;
    removeBasedActor?(actor: ICollidable): void;
}

/**
 * A convex hull as UE2 stores it: `[nx, ny, nz, d, ?]` planes plus a cached AABB.
 * Produced in Phase 2 by `colliding-mesh.ts` / `bsp-collider.ts`.
 */
export type CollisionHull_T = {
    planes: [number, number, number, number, number][];
    bounds: THREE.Box3;
};

/** Uniform-grid acceleration structure over a hull set (Phase 2). */
export type CollisionBspIndex_T = {
    cellSize: number;
    keys: Int32Array;
    offsets: Uint32Array;
    hullIndices: Uint32Array;
    largeHullIndices: Uint32Array;
    marks: Uint32Array;
    queryTag: number;
};

/** 2D XY bucket grid over a triangle soup (terrain / static-mesh collision, Phase 2). */
export type CollisionTriangleIndex_T = {
    minX: number;
    minY: number;
    cellSizeX: number;
    cellSizeY: number;
    sizeX: number;
    sizeY: number;
    offsets: Uint32Array;
    triangleIndices: Uint32Array;
    marks: Uint32Array;
    queryTag: number;
};

type CollisionPrimitiveUnion_T =
    | {
        kind: "bsp";
        hulls: CollisionHull_T[];
        index: CollisionBspIndex_T;
        bounds: THREE.Box3;
        supportsZeroExtent: boolean;
        supportsNonZeroExtent: boolean;
        supportsPointCheck: boolean;
    }
    | {
        kind: "staticMesh";
        vertices: Float32Array;
        indices: Uint32Array;
        collisionNodes: Int32Array;
        collisionBounds: Float32Array;
        index?: CollisionTriangleIndex_T;
        simpleCollisionHulls?: CollisionHull_T[];
        useSimpleLineCollision?: boolean;
        useSimpleBoxCollision?: boolean;
        matrixWorld: THREE.Matrix4;
        bounds: THREE.Box3;
        supportsZeroExtent: boolean;
        supportsNonZeroExtent: boolean;
        supportsPointCheck: boolean;
    }
    | {
        kind: "terrain";
        vertices: Float32Array;
        indices: Uint32Array;
        index: CollisionTriangleIndex_T;
        matrixWorld: THREE.Matrix4;
        bounds: THREE.Box3;
        supportsZeroExtent: boolean;
        supportsNonZeroExtent: boolean;
        supportsPointCheck: boolean;
    }
    | {
        kind: "cylinder";
        center: THREE.Vector3;
        radius: number;
        halfHeight: number;
        bounds: THREE.Box3;
        supportsZeroExtent: boolean;
        supportsNonZeroExtent: boolean;
        supportsPointCheck: boolean;
    };

export type CollisionPrimitiveKind = CollisionPrimitiveUnion_T["kind"];

export type CollisionPrimitive_T<T extends CollisionPrimitiveKind = CollisionPrimitiveKind> = Extract<CollisionPrimitiveUnion_T, { kind: T }>;

/** AActor collision flags, see `AActor::IsBlockedBy` 0x7cd650. */
export type ActorCollisionProfile_T = {
    collideActors: boolean;
    collideWorld: boolean;
    blockActors: boolean;
    blockPlayers: boolean;
    blockZeroExtent: boolean;
    blockNonZeroExtent: boolean;
    worldGeometry: boolean;
    useCylinderCollision: boolean;
    collisionRadius: number;
    collisionHeight: number;
    isPawn?: boolean;
};
