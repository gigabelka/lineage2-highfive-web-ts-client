import { AnimationAction, AnimationClip, LoopOnce, LoopRepeat, Mesh, Vector3 } from "three";
import { COMPONENT_EVENT_NOT_HANDLED, ComponentEventResult_T, ObjectComponent } from "@client/game/components";
import { ANIMATION_NOTIFY_EVENT, MESHES_CHANGED_EVENT, SCRIPT_NATIVE_EVENT } from "@client/game/component-events";
import type { ScriptValue_T } from "@client/ue-script/script-values";
import type { PawnMovementState_T } from "@client/physics/components/pawn-movement-component";
import type BaseActor from "@client/base-actor";
import type RenderManager from "@client/rendering/render-manager";

/**
 * A single animation-notify entry, as decoded off `UAnimationNotify`/`USkeletalMesh`.
 *
 * TODO(decode-side, parallel workstream): the donor project types this as `IAnimationNotifyDecodeInfo`
 * from its `@l2js/engine/contracts/anim-notify`. Main has no such contract yet and `animationNotifies`
 * is one of the fields the concurrent decode work is adding to `GD.ISkinnedMeshObjectDecodeInfo`.
 * Only `time` (a 0..1 normalized frame position) is read here, so this local structural shape is
 * deliberately minimal - widen it against the real decode-info once that field lands.
 */
export type AnimationNotifyDecodeInfo_T = { time: number };

const MOVEMENT_TWEEN_TIME = 0.1;
const IDLE_TWEEN_TIME = MOVEMENT_TWEEN_TIME * 2;
const cacheOnceAnimations = new WeakMap<AnimationClip, AnimationClip>();

function getOnceAnimation(clip: AnimationClip): AnimationClip {
    let once = cacheOnceAnimations.get(clip);

    if (once) return once;

    once = clip.clone();

    // decoded looping clips close on frame 0; LoopOnce holds the preceding real frame instead
    for (const track of once.tracks) {
        const size = track.getValueSize();

        if (track.values.length >= size * 2)
            track.values.copyWithin(track.values.length - size, track.values.length - size * 2, track.values.length - size);
    }

    (once as any).animationNotifies = (clip as any).animationNotifies;
    (once as any).skinNotify = (clip as any).skinNotify;
    (once as any).attackEffectFrame = (clip as any).attackEffectFrame;
    (once as any).attackEndEffectFrame = (clip as any).attackEndEffectFrame;
    cacheOnceAnimations.set(clip, once);

    return once;
}

/**
 * Three.js `AnimationMixer` wrapper for one pawn: owns every clip action it plays, tracks a
 * current/previous action per mesh part so a state change can cross-fade, and turns the mixer's
 * advancing time into `ANIMATION_NOTIFY_EVENT`s for the sound/effects/skin-notify components.
 *
 * Like the donor project, it claims the meshes it is given by flagging `hasStartedAnimation` on
 * them - see RenderManager's Wait-clip autoplay pass, which must not fight this component for
 * ownership of the same mesh.
 */
export class AnimationComponent extends ObjectComponent<BaseActor> {
    public readonly componentName = "animation";
    protected readonly renderManager: RenderManager;
    protected meshes: Mesh[] = [];
    protected currAnimations = new WeakMap<Mesh, AnimationAction>();
    protected prevAnimations = new WeakMap<Mesh, AnimationAction>();
    protected actorAnimations: Record<string, AnimationClip> = {};
    protected animationNotifyAction: AnimationAction = null;
    protected animationNotifyTime = 0;
    protected isAnimationsInit = false;
    protected readonly basicActorAnimations: BasicActorAnimations_T = {
        idle: null,
        walking: null,
        running: null,
        dying: null,
        falling: null,
        swimming: null,
        swimmingIdle: null
    };

    public constructor(renderManager: RenderManager) {
        super();

        this.renderManager = renderManager;
    }

    public onUpdate(_currentTime: number, _deltaTime: number): void {
        const action = this.animationNotifyAction;

        if (!action) return;

        const oldTime = this.animationNotifyTime;
        const time = action.time;

        this.animationNotifyTime = time;

        if (time === oldTime) return;

        const duration = action.getClip().duration;
        const notifications = (action.getClip() as any).animationNotifies as AnimationNotifyDecodeInfo_T[];

        if (!notifications || notifications.length === 0 || duration <= 0) return;

        const oldFrame = oldTime / duration;
        const frame = time / duration;
        const forward = action.getEffectiveTimeScale() >= 0;

        for (let i = 0, len = notifications.length; i < len; i++) {
            const notify = notifications[i];
            const notifyTime = notify.time;
            const crossed = forward
                ? frame >= oldFrame ? oldFrame < notifyTime && notifyTime <= frame : oldFrame < notifyTime || notifyTime <= frame
                : frame <= oldFrame ? frame <= notifyTime && notifyTime < oldFrame : notifyTime < oldFrame || frame <= notifyTime;

            if (crossed) this.dispatchEvent(ANIMATION_NOTIFY_EVENT, notify);
        }
    }

    public onEvent(type: string, _data: unknown): ComponentEventResult_T<ScriptValue_T> {
        if (type !== SCRIPT_NATIVE_EVENT) return COMPONENT_EVENT_NOT_HANDLED;

        // ScriptComponent lands in Phase 4 - no-op until then.
        // The donor handles four natives here off the payload (`_data as ScriptNativeCall_T`), keyed by call.index:
        //   259 PlayAnim / 260 LoopAnim  -> this.play(args[0], args[2] ?? 0, args[1] ?? 1, loop, true)
        //   282 IsAnimating              -> this.animationNotifyAction?.isRunning()
        //   0   GetAnimParams            -> writes name/frame/rate into three out-slots via isScriptSlot()
        // All three need `vm.ts`'s ScriptNativeCall_T/isScriptSlot (Phase 4) and a live ScriptComponent,
        // so porting the bodies now would be untestable dead code.
        return COMPONENT_EVENT_NOT_HANDLED;
    }

    public getMeshes(): readonly Mesh[] { return this.meshes; }
    public getAction(): AnimationAction { return this.animationNotifyAction; }

    public setMeshes(meshes: Mesh[]): void {
        const parent = this.getParent();

        this.stop();

        for (const mesh of this.meshes) parent.remove(mesh);

        this.meshes = meshes;

        for (const mesh of meshes) {
            /* claiming the mesh here is what keeps RenderManager's Wait-clip autoplay pass (which keys
               off the very same flag) from starting a second, competing action on it */
            (mesh as any).hasStartedAnimation = true;
            mesh.frustumCulled = false;
            parent.add(mesh);
        }

        this.dispatchEvent(MESHES_CHANGED_EVENT, meshes);
        // TODO(lighting follow-up): the donor invalidates its per-actor light cache here
        // (renderManager.invalidatePawnLighting(parent)). Main has no such cache yet - LitSkinnedMesh and
        // the actorLights uniform block are deliberately not ported (see the Phase 3b report) - so there is
        // nothing to invalidate until that decision is made.
    }

    public getBoneWorldPosition(name: string, target: Vector3): Vector3 {
        for (const mesh of this.meshes) {
            const skeleton = (mesh as any).skeleton as THREE.Skeleton;

            if (!skeleton) continue;

            const bone = skeleton.bones.find(bone => bone.name === name);

            if (bone) return bone.getWorldPosition(target);
        }

        throw new Error(`${this.getParent().type} has no '${name}' bone.`);
    }

    public setAnimations(animations: Record<string, AnimationClip>): void {
        this.stop();
        this.getComponent<any>("pawnMovement").resetAnimationState();
        this.actorAnimations = animations;
    }

    public setBasicAnimation(key: PawnMovementState_T, animationName: string): void {
        const resolvedName = Object.keys(this.actorAnimations).find(name => name.toLowerCase() === animationName.toLowerCase());

        if (!resolvedName) throw new Error(`'${animationName}' is not available.`);
        if (!(key in this.basicActorAnimations)) throw new Error(`'${key}' is not a valid basic actor animation`);

        (this.basicActorAnimations as any)[key] = resolvedName;
    }

    public playMovement(state: PawnMovementState_T): void {
        const tweenTime = state === "idle" || state === "swimmingIdle" ? IDLE_TWEEN_TIME : MOVEMENT_TWEEN_TIME;

        this.play(this.basicActorAnimations[state], tweenTime);
    }

    public setDeathAnimationFromScript(): void {
        const parent = this.getParent();

        // ScriptComponent lands in Phase 4 - no-op until then: this needs GetDeathAnimName() off the
        // actor's UnrealScript class, which main cannot execute yet.
        const script = this.findComponent<any>("script");

        if (!script) return;

        const oldWeaponType = parent.getUnrealScriptProperty("CurWeaponType");
        let invalidAnimationName: string = null;

        try {
            for (let weaponType = 0; weaponType < 8; weaponType++) {
                parent.setUnrealScriptProperty("CurWeaponType", weaponType);

                const animationName = script.call("GetDeathAnimName");

                if (typeof animationName !== "string") throw new Error(`${parent.type} has invalid death animation '${animationName}'.`);
                if (animationName.toLowerCase() === "none") continue;

                const resolvedName = Object.keys(this.actorAnimations).find(name => name.toLowerCase() === animationName.toLowerCase());

                if (!resolvedName) {
                    invalidAnimationName = animationName;
                    continue;
                }

                this.setBasicAnimation("dying", resolvedName);
                return;
            }
        } finally {
            parent.setUnrealScriptProperty("CurWeaponType", oldWeaponType);
        }

        if (invalidAnimationName) throw new Error(`'${invalidAnimationName}' is not available.`);
    }

    public init(): void {
        this.isAnimationsInit = true;
        this.play(this.basicActorAnimations.idle, IDLE_TWEEN_TIME);
    }

    public playEnter(animationName: string): void {
        if (animationName && animationName.toLowerCase() !== "none") this.play(animationName, MOVEMENT_TWEEN_TIME, 1, false, true);
    }

    public playDeath(): void { this.play(this.basicActorAnimations.dying, MOVEMENT_TWEEN_TIME, 1, false, true); }

    public onAnimationFinished(action: AnimationAction, isDying: boolean): boolean {
        if (action !== this.animationNotifyAction) return false;

        this.animationNotifyTime = 0;

        if (isDying) {
            action.stop();
            this.animationNotifyAction = null;
            return true;
        }

        // ScriptComponent lands in Phase 4 - no-op until then (the donor raises AnimEnd on the actor here).
        const script = this.findComponent<any>("script");

        if (script) {
            script.call("AnimEnd", [0]);

            if (this.animationNotifyAction !== action) return true;
        }

        this.animationNotifyAction = null;

        return true;
    }

    public isPlayingOneShot(animationName: string): boolean {
        const action = this.animationNotifyAction;

        return !!action && action.isRunning() && action.loop === LoopOnce && action.getClip().name.toLowerCase() === animationName.toLowerCase();
    }

    public play(animationName: string, tweenTime: number = MOVEMENT_TWEEN_TIME, rate: number = 1, loop: boolean = true, restart: boolean = false): void {
        if (!this.isAnimationsInit) return;

        const resolvedName = Object.keys(this.actorAnimations).find(name => name.toLowerCase() === animationName.toLowerCase());

        if (!resolvedName) throw new Error(`'${animationName}' is not available.`);

        const sourceClip = this.actorAnimations[resolvedName];
        const clip = loop ? sourceClip : getOnceAnimation(sourceClip);
        const mixer = this.renderManager.mixer;
        let notifyAction: AnimationAction = null;
        let didBegin = false;

        for (const mesh of this.meshes) {
            if ((mesh as any).isBoneAttachment) continue; // rides the bone it hangs off, its own skeleton is untouched by this clip
            if ((mesh as any).sharesSkeleton) continue; // skinned off the bodypart that owns the bone tree, one action drives both

            const prevAct = this.prevAnimations.get(mesh) || null;
            const currAct = this.currAnimations.get(mesh) || null;
            const nextAct = mixer.clipAction(clip, mesh);

            if (!notifyAction) notifyAction = nextAct;

            nextAct.setEffectiveTimeScale(rate);
            nextAct.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
            nextAct.clampWhenFinished = !loop;

            if (currAct === nextAct) {
                if (restart || !nextAct.isRunning()) {
                    nextAct.reset().play();
                    didBegin = true;
                }
                continue;
            }

            this.currAnimations.set(mesh, nextAct);

            if (prevAct) prevAct.stop();
            nextAct.reset();

            if (currAct && (currAct.isRunning() || currAct.enabled && currAct.paused)) {
                this.prevAnimations.set(mesh, currAct);
                currAct.crossFadeTo(nextAct, tweenTime, false);
            } else if (currAct) currAct.stop();

            nextAct.play();
            didBegin = true;
        }

        if (this.animationNotifyAction !== notifyAction) {
            this.animationNotifyAction = notifyAction;
            this.animationNotifyTime = notifyAction ? notifyAction.time : 0;
        }

        // ScriptComponent lands in Phase 4 - no-op until then (the donor raises AnimBegin here).
        const script = this.findComponent<any>("script");

        if (didBegin && script?.hasFunction?.("AnimBegin")) script.call("AnimBegin", [resolvedName]);
    }

    public stop(): void {
        for (const mesh of this.meshes) {
            if (this.prevAnimations.has(mesh)) this.prevAnimations.get(mesh).stop();
            if (this.currAnimations.has(mesh)) this.currAnimations.get(mesh).stop();
        }

        this.animationNotifyAction = null;
        this.animationNotifyTime = 0;
    }

    public release(): void {
        this.stop();

        for (const mesh of this.meshes) {
            this.renderManager.mixer.uncacheRoot(mesh);
            mesh.geometry.dispose();
        }
    }
}

type BasicActorAnimations_T = Record<PawnMovementState_T, string>;

export default AnimationComponent;
