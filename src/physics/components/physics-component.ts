import { Vector3 } from "three";
import { IComponent, IObject, ObjectComponent } from "@client/game/components";
import type BaseActor from "@client/base-actor";
import type { ICollidable } from "@client/objects/objects";
import type { CheckResult_T, CollisionQuery_T, RayCheckResult_T } from "@client/physics/collision-world";
import type RAPIER from "@dimforge/rapier3d";

/**
 * What a physics component needs from whoever owns the simulation.
 *
 * The donor project has a standalone `PhysicsManager`; per the port plan no new top-level managers
 * are introduced here, so `RenderManager` implements this interface directly (fields + per-frame
 * tick live there). Everything is a thin delegate onto `CollisionWorld` / `RAPIER.World`.
 *
 * `MoverComponent`/`RotatingComponent` from the donor file are deliberately NOT ported - main
 * already covers them with `src/objects/movable-object.ts` and `src/objects/rotating-object.ts`.
 */
export interface IPhysicsHost {
    updateDynamicEntries(currentTime: number): void;
    moveActor(query: CollisionQuery_T): CheckResult_T | null;
    singleLineCheck(query: CollisionQuery_T): CheckResult_T | null;
    rayCheck(origin: Vector3, direction: Vector3, maxDistance: number, sourceCollider?: RAPIER.Collider, sourceBody?: RAPIER.RigidBody, sourceIsPlayer?: boolean): RayCheckResult_T | null;
    registerCollider(object: ICollidable): void;
    unregisterCollider(object: ICollidable): void;
    registerPhysicsComponent(component: IPhysicsComponent<any>): void;
    unregisterPhysicsComponent(component: IPhysicsComponent<any>): void;
}

export interface IPhysicsComponent<TParent extends IObject = IObject> extends IComponent<TParent> {
    readonly isPhysicsComponent: boolean;
    isPhysicsAdded(manager: IPhysicsHost): boolean;
    onPhysicsAdded(manager: IPhysicsHost): void;
    onPhysicsRemoved(manager: IPhysicsHost): void;
    getPhysicsTickRate?(): number;
    onPhysicsTick?(currentTime: number, deltaTime: number, actors: BaseActor[]): boolean;
    onTriggerPosition?(currentTime: number, position: Vector3): void;
}

export abstract class PhysicsComponent<TParent extends IObject = IObject> extends ObjectComponent<TParent> implements IPhysicsComponent<TParent> {
    declare public readonly isPhysicsComponent: boolean;
    protected physicsManager: IPhysicsHost = null;

    public constructor() {
        super();

        (this as any).isPhysicsComponent = true;
    }

    public isPhysicsAdded(manager: IPhysicsHost): boolean { return this.physicsManager === manager; }

    public onPhysicsAdded(manager: IPhysicsHost): void {
        if (this.physicsManager) throw new Error(`Physics component '${this.componentName}' is already registered.`);

        this.physicsManager = manager;
    }

    public onPhysicsRemoved(manager: IPhysicsHost): void {
        if (this.physicsManager !== manager) throw new Error(`Physics component '${this.componentName}' is not registered here.`);

        this.physicsManager = null;
    }

    public onDetach(): void {
        if (this.physicsManager) this.physicsManager.unregisterPhysicsComponent(this);
    }
}

export class ColliderComponent extends PhysicsComponent<ICollidable & IObject> {
    public readonly componentName = "collider";
    protected isRegistered = false;

    public onPhysicsAdded(manager: IPhysicsHost): void {
        super.onPhysicsAdded(manager);

        const object = this.getParent();

        if (!object.isCollidable) return;

        manager.registerCollider(object);
        this.isRegistered = true;
    }

    public onPhysicsRemoved(manager: IPhysicsHost): void {
        if (this.isRegistered) manager.unregisterCollider(this.getParent());

        this.isRegistered = false;
        super.onPhysicsRemoved(manager);
    }

    public refresh(object: ICollidable & IObject & { refreshCollisionGeometry(): void }): void {
        if (this.isRegistered) this.physicsManager.unregisterCollider(object);

        object.refreshCollisionGeometry();

        if (this.isRegistered) this.physicsManager.registerCollider(object);
    }
}

export default PhysicsComponent;
