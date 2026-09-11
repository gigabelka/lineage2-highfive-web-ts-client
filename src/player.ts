import { Mesh, Vector3 } from "three";
import BaseActor from "@client/base-actor";
import type RenderManager from "@client/rendering/render-manager";
import type { SectorObject } from "@client/objects/zone-object";

const tmpCameraTarget = new Vector3();

export class Player extends BaseActor {
    public readonly isPlayer = true;
    public readonly type = "Player";

    protected cameraTargetHeight: number = 0;

    public constructor(renderManager: RenderManager) {
        super(renderManager);

        this.movementComponent.setPhysicsTickRate(60);
        // WaterEffectsComponent/LandmarkComponent land in Phase 7
    }

    public setMeshes(meshes: Mesh[]) {
        super.setMeshes(meshes);

        this.getBoneWorldPosition("bip01_spine1", tmpCameraTarget);
        this.cameraTargetHeight = tmpCameraTarget.z - this.position.z;
    }

    public getCameraTargetPosition(target: Vector3): Vector3 {
        return target.copy(this.position).setZ(this.position.z + this.cameraTargetHeight);
    }

    /** main's DI singleton, set in core.ts. */
    public getRenderManager(): RenderManager {
        return (global as any).renderManager as RenderManager;
    }

    public getSector(): SectorObject | null {
        return this.getRenderManager().getSector(this.position);
    }
}

export default Player;
