import { AnimationAction, AnimationClip, Mesh, Object3D, Sphere, Vector3 } from "three";
import RAPIER from "@dimforge/rapier3d";
import type { ActorCollisionProfile_T, CollisionPrimitive_T, ICollidable } from "@client/objects/objects";
import type RenderManager from "@client/rendering/render-manager";
import type { CheckResult_T } from "@client/physics/collision-world";
import type { ScriptNativeCall_T, ScriptValue_T, Vector3Arr } from "@client/ue-script/script-values";
import { COMPONENT_EVENT_NOT_HANDLED, GameObject } from "@client/game/components";
import { ColliderComponent } from "@client/physics/components/physics-component";
import PawnMovementComponent, { PawnMovementState_T } from "@client/physics/components/pawn-movement-component";
import AnimationComponent from "@client/objects/components/animation-component";
import PawnRenderableComponent from "@client/rendering/components/pawn-renderable-component";
import NpcLifecycleComponent from "@client/objects/components/npc-lifecycle-component";

/**
 * Components looked up by name below that do not exist yet:
 *   "transform"      -> TransformComponent      (Phase 4)
 *   "script"         -> ScriptComponent         (Phase 4)
 * The lookup pattern is kept verbatim from the donor project; the accessors that reach components
 * from a later phase use `findComponent` so they degrade to a no-op instead of throwing, while
 * everything that is attached unconditionally (see the constructor) uses `getComponent` and throws
 * loudly if the component is ever missing - that is intentional.
 */

const tmpUp = new Vector3(0, 0, 1);

export class BaseActor extends GameObject implements ICollidable {
    public readonly isActor = true;
    declare public readonly isCollidable: boolean;
    public readonly type: string = "Actor";

    protected renderManager: RenderManager;
    protected readonly movementComponent: PawnMovementComponent;

    public constructor(renderManager: RenderManager) {
        super();

        (this as any).isCollidable = true;

        this.renderManager = renderManager;
        this.up.copy(tmpUp);
        this.movementComponent = this.addComponent(new PawnMovementComponent(renderManager));
        this.addComponent(new ColliderComponent());

        /*
         * The donor attaches these - plus sound/effects/hairSimulation/skinNotify/transform/
         * npcLifecycle - from `AssetManager.setPawnComponents()`, i.e. lazily, on the character/NPC
         * load path. Main's AssetManager only streams sectors today, so the two components that exist
         * attach here instead, and the `findComponent` guards keep the donor's idempotent pattern
         * working when the later phases add their own setPawnComponents-style helper.
         */
        if (!this.findComponent("animation")) this.addComponent(new AnimationComponent(renderManager));
        if (!this.findComponent("pawnRenderable")) this.addComponent(new PawnRenderableComponent(renderManager));
        if (!this.findComponent("npcLifecycle")) this.addComponent(new NpcLifecycleComponent());
    }

    protected get animationComponent(): AnimationComponent { return this.getComponent<AnimationComponent>("animation"); }

    // --- UnrealScript bridge ---------------------------------------------------------------
    // The VM lands in Phase 4. These carry their final public signatures so Phase 4 only has to
    // fill in `setScriptRuntime`/`beginPlay` and attach a real ScriptComponent; nothing here
    // executes bytecode today.

    public get scriptClassId(): string { return null; }
    public get scriptProperties(): Map<string, ScriptValue_T> { return null; }

    /** Phase 4: constructs a ScriptComponent bound to the VM and attaches it. */
    public setScriptRuntime(_vm: unknown, _classId: string, _objectFactory: unknown): void {
        throw new Error("UnrealScript VM is not implemented yet (Phase 4).");
    }

    public beginPlay(): void { /* Phase 4: this.scriptComponent?.beginPlay(); */ }

    public resolveUnrealObject(id: string): string { return id; }

    public getUnrealScriptProperty(id: string): ScriptValue_T {
        const name = id.slice(id.lastIndexOf(".") + 1).toLowerCase();

        switch (name) {
            case "location": return [this.position.x, this.position.y, this.position.z];
            case "velocity": return this.movementComponent.getVelocity().toArray();
            case "acceleration": return this.movementComponent.getAcceleration().toArray();
            case "collisionradius": return this.movementComponent.getCollisionRadius();
            case "collisionheight": return this.movementComponent.getCollisionHeight();
            case "biswalking": return this.movementComponent.isWalkingMovement();
            case "physics": return ["none", "walking", "falling", "swimming", "flying"].indexOf(this.movementComponent.getPhysicsMode());
        }

        return this.getStoredUnrealScriptProperty(id);
    }

    protected getStoredUnrealScriptProperty(id: string): ScriptValue_T {
        const name = id.slice(id.lastIndexOf(".") + 1).toLowerCase();
        const properties = this.scriptProperties;

        if (!properties) return null;
        if (properties.has(id)) return properties.get(id);

        for (const [key, value] of properties)
            if (key.slice(key.lastIndexOf(".") + 1).toLowerCase() === name) return value;

        return null;
    }

    public setUnrealScriptProperty(id: string, value: ScriptValue_T): void {
        const field = id.slice(id.lastIndexOf(".") + 1);

        switch (field.toLowerCase()) {
            case "location": this.position.fromArray(value as Vector3Arr); return;
            case "velocity": this.movementComponent.setVelocity(value as Vector3Arr); return;
            case "acceleration": this.movementComponent.setAcceleration(value as Vector3Arr); return;
            case "collisionradius": this.movementComponent.setCollisionSize(Number(value), this.movementComponent.getCollisionHeight()); return;
            case "collisionheight": this.movementComponent.setCollisionSize(this.movementComponent.getCollisionRadius(), Number(value)); return;
            case "biswalking": this.movementComponent.setWalking(!!value); return;
            case "physics": this.movementComponent.setPhysicsMode(Number(value)); return;
        }

        if (!this.scriptProperties) throw new Error(`${this.type} has no UnrealScript property storage.`);

        for (const key of this.scriptProperties.keys())
            if (key.slice(key.lastIndexOf(".") + 1).toLowerCase() === field.toLowerCase()) {
                this.scriptProperties.set(key, value);
                return;
            }

        this.scriptProperties.set(field, value);
    }

    public callUnrealNative(call: ScriptNativeCall_T): ScriptValue_T {
        // Phase 4 routes this through ScriptComponent.dispatchNative first.
        const componentResult = COMPONENT_EVENT_NOT_HANDLED as unknown;

        if (componentResult !== COMPONENT_EVENT_NOT_HANDLED) return componentResult as ScriptValue_T;

        throw new Error(`UnrealScript native '${call.name}' (${call.index}) is not implemented for '${call.context.scriptClassId}'.`);
    }

    // --- collision / movement --------------------------------------------------------------

    public getAnimationAction(): AnimationAction { return this.animationComponent.getAction(); }

    public getCollisionRadius(): number { return this.movementComponent.getCollisionRadius(); }
    public getCollisionHeight(): number { return this.movementComponent.getCollisionHeight(); }
    public getCollider(): RAPIER.Collider { return this.movementComponent.getCollider(); }
    public getRigidbody(): RAPIER.RigidBody { return this.movementComponent.getRigidbody(); }
    public getBaseActor(): ICollidable | null { return this.movementComponent.getBaseActor(); }
    public getBasedActors(): ReadonlySet<ICollidable> { return this.movementComponent.getBasedActors(); }
    public addBasedActor(actor: ICollidable): void { this.movementComponent.addBasedActor(actor); }
    public removeBasedActor(actor: ICollidable): void { this.movementComponent.removeBasedActor(actor); }
    public setBase(actor: ICollidable | null): void { this.movementComponent.setBase(actor); }
    public getCollisionProfile(): ActorCollisionProfile_T { return this.movementComponent.getCollisionProfile(); }
    public getCollisionPrimitive(): CollisionPrimitive_T { return this.movementComponent.getCollisionPrimitive(); }
    public createCollider(physicsWorld: RAPIER.World): RAPIER.Collider { return this.movementComponent.createCollider(physicsWorld); }
    public releaseCollider(): void { this.movementComponent.releaseCollider(); }
    public ignoreOverlappingActors(actors: Iterable<ICollidable>): void { this.movementComponent.ignoreOverlappingActors(actors); }
    public moveSmooth(movement: Vector3, ignoredActor?: ICollidable): void { this.movementComponent.moveSmooth(movement, ignoredActor); }
    public moveActor(position: Vector3, movement: Vector3): CheckResult_T | null { return this.movementComponent.moveActor(position, movement); }
    public isInteractive(): boolean { return this.movementComponent.isInteractive(); }

    public updatePresentation(currentTime: number, deltaTime: number) {
        this.updateComponents(currentTime, deltaTime);
    }

    public update(_renderManager: RenderManager, currentTime: number, deltaTime: number) {
        this.updatePresentation(currentTime, deltaTime);
    }

    public getBoneWorldPosition(name: string, target: Vector3): Vector3 { return this.animationComponent.getBoneWorldPosition(name, target); }

    public attachObjectToBone(object: Object3D, boneNameOrIndex: string | number): boolean { return this.getComponent<any>("transform").attachObjectToBone(object, boneNameOrIndex); }
    public detachBoneObject(object: Object3D): boolean { return this.getComponent<any>("transform").detachBoneObject(object); }
    public gainScriptChild(object: Object3D): void { this.getComponent<any>("transform").gainScriptChild(object); }
    public loseScriptChild(object: Object3D): void { this.getComponent<any>("transform").loseScriptChild(object); }

    public getRenderSphere(): Sphere { return this.getComponent<PawnRenderableComponent>("pawnRenderable").getRenderSphere(); }

    public setMeshes(meshes: Mesh[]): void { this.animationComponent.setMeshes(meshes); }

    public setAnimations(animations: Record<string, AnimationClip>): void { this.animationComponent.setAnimations(animations); }
    public stopAnimations(): void { this.animationComponent.stop(); }

    // materials and textures stay - material-decoder hands those out of name-keyed shared caches
    public release(): void {
        this.findComponent<any>("npcLifecycle")?.release();
        this.detachComponents();
    }

    public setIdleAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("idle", animationName); }
    public setWalkingAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("walking", animationName); }
    public setRunningAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("running", animationName); }
    public setDeathAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("dying", animationName); }
    public setFallingAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("falling", animationName); }
    public setSwimmingAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("swimming", animationName); }
    public setSwimmingIdleAnimation(animationName: string): void { this.animationComponent.setBasicAnimation("swimmingIdle", animationName); }
    public playMovementAnimation(state: PawnMovementState_T): void { this.animationComponent.playMovement(state); }
    public setDeathAnimationFromScript(): void { this.animationComponent.setDeathAnimationFromScript(); }
    public initAnimations(): void { this.animationComponent.init(); }

    public spawnEnterEvent(event: unknown): void {
        this.getComponent<any>("npcLifecycle").spawnEnter(event);
    }

    public onAnimationFinished(action: AnimationAction): void { this.getComponent<any>("npcLifecycle").onAnimationFinished(action); }

    public playDeathAnimation(onFinished: (actor: BaseActor) => void): void { this.getComponent<any>("npcLifecycle").playDeath(onFinished); }

    public isPlayingOneShotAnimation(animationName: string): boolean { return this.animationComponent.isPlayingOneShot(animationName); }
    public playAnimation(animationName: string, tweenTime: number = 0.1, rate: number = 1, loop: boolean = true, restart: boolean = false): void { this.animationComponent.play(animationName, tweenTime, rate, loop, restart); }
    public getAnimationNames(): string[] { return this.animationComponent.getAnimationNames(); }
    public getIdleAnimationName(): string { return this.animationComponent.getIdleAnimationName(); }

    public goTo(position: Vector3): void { this.movementComponent.goTo(position); }
    public goToActor(actor: Object3D, offset: number = 0): void { this.movementComponent.goToActor(actor, offset); }
    public moveInDirection(direction: Vector3, faceMovement: boolean = true): void { this.movementComponent.moveInDirection(direction, faceMovement); }
    public faceActor(actor: Object3D | null): void { this.movementComponent.faceActor(actor); }
    public stopMoving(): void { this.movementComponent.stopMoving(); }
    public setWalking(isWalking: boolean): void { this.movementComponent.setWalking(isWalking); }
    public isIdle(): boolean { return this.movementComponent.isIdle(); }
    public isLocomoting(): boolean { return this.movementComponent.isLocomoting(); }
    public isWalkingMovement(): boolean { return this.movementComponent.isWalkingMovement(); }
    public isSwimmingMovement(): boolean { return this.movementComponent.isSwimmingMovement(); }
    public getSpeed(): number { return this.movementComponent.getSpeed(); }
    public isUnderwaterMovement(): boolean { return this.movementComponent.isUnderwaterMovement(); }
    public setFlying(isFlying: boolean): void { this.movementComponent.setFlying(isFlying); }
    public setAirSpeed(airSpeed: number): void { this.movementComponent.setAirSpeed(airSpeed); }
    public setCollisionSize(collisionRadius: number, collisionHeight: number): void { this.movementComponent.setCollisionSize(collisionRadius, collisionHeight); }
    public teleportTo(position: Vector3): void { this.movementComponent.teleportTo(position); }
}

export default BaseActor;
