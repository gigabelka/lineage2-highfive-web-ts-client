import { Vector3 } from "three";
import { PhysicsComponent } from "@client/physics/components/physics-component";
import type BaseActor from "@client/base-actor";
import type RenderManager from "@client/rendering/render-manager";

const tmpDirection = new Vector3();

/**
 * Debug-only "crowd" behaviour for the Character panel's Simulate Pawns button: turns to a random
 * direction every `TURN_INTERVAL` and walks it, then despawns itself once `expires` passes. No
 * aggro/targeting/combat - this only exists to put moving bodies in the world for a stress test.
 */
export class NpcSimulationComponent extends PhysicsComponent<BaseActor> {
    public static readonly DEFAULT_COUNT = 10;
    public static readonly LIFETIME = 15000;
    protected static readonly TURN_INTERVAL = 1000;

    public readonly componentName = "npcSimulation";
    protected expires = Infinity;
    protected nextTurn = Infinity;

    public configure(expires: number, nextTurn: number): void {
        this.expires = expires;
        this.nextTurn = nextTurn;
    }

    public onPhysicsTick(currentTime: number, _deltaTime: number, _actors: BaseActor[]): boolean {
        const pawn = this.getParent();

        if (currentTime >= this.expires) {
            (this.physicsManager as RenderManager).removePawn(pawn);
            return true;
        }

        if (currentTime < this.nextTurn) return false;

        this.nextTurn = currentTime + NpcSimulationComponent.TURN_INTERVAL;

        const angle = Math.random() * Math.PI * 2;

        pawn.moveInDirection(tmpDirection.set(Math.cos(angle), Math.sin(angle), 0));

        return true;
    }
}

export default NpcSimulationComponent;
