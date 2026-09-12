import { AnimationAction } from "three";
import { ObjectComponent } from "@client/game/components";
import { NPC_ENTER_EVENT } from "@client/game/component-events";
import type AnimationComponent from "@client/objects/components/animation-component";
import type PawnMovementComponent from "@client/physics/components/pawn-movement-component";
import type BaseActor from "@client/base-actor";

/**
 * Owns an actor's spawn-enter/death lifecycle: the donor project also routes this through a
 * `ScriptComponent` (setting `Controller.bDead` and calling `NotifyDie`), but the UnrealScript VM
 * is not implemented yet (Phase 4) - this port keeps only the animation-driven half, so NPCs play
 * their enter/death clips correctly but never notify a script-side controller.
 */
export class NpcLifecycleComponent extends ObjectComponent<BaseActor> {
    public readonly componentName = "npcLifecycle";
    protected deathAnimationFinishedHandler: ((actor: BaseActor) => void) = null;
    protected isDying = false;
    protected isReleased = false;

    public onDetach(): void { this.release(); }

    public spawnEnter(event: GD.INpcEnterEvent): void {
        this.dispatchEvent(NPC_ENTER_EVENT, event);
        this.getComponent<PawnMovementComponent>("pawnMovement").startEnterRise(event.isRise);
        this.getComponent<AnimationComponent>("animation").playEnter(event.animation);
    }

    public onAnimationFinished(action: AnimationAction): void {
        if (!this.getComponent<AnimationComponent>("animation").onAnimationFinished(action, this.isDying)) return;
        if (!this.isDying) return;

        const handler = this.deathAnimationFinishedHandler;

        this.deathAnimationFinishedHandler = null;
        if (handler) handler(this.getParent());
    }

    public playDeath(onFinished: (actor: BaseActor) => void): void {
        if (this.isDying) return;

        this.isDying = true;
        this.deathAnimationFinishedHandler = onFinished;
        this.getComponent<PawnMovementComponent>("pawnMovement").setDying();
        this.getComponent<AnimationComponent>("animation").playDeath();
    }

    public release(): void {
        if (this.isReleased) return;

        this.isReleased = true;
        this.getComponent<AnimationComponent>("animation").release();
        this.deathAnimationFinishedHandler = null;
        this.isDying = false;
    }
}

export default NpcLifecycleComponent;
