/**
 * Cross-cutting component event names.
 *
 * Single source of truth for the event strings that travel through
 * `ComponentCollection.dispatch` (see `./components.ts`). The donor project declares these ad hoc
 * in the modules that raise them (`sound-component.ts`, `animation-component.ts`,
 * `script-component.ts`, `pawn-movement-component.ts`); as those modules land in later phases they
 * must import from here instead of re-declaring.
 *
 * String values are the donor's verbatim literals - they are the wire format between components,
 * never rename them.
 */

/** AnimationComponent -> SoundComponent/EffectsComponent/NpcLifecycleComponent (Phase 3/6). */
export const ANIMATION_NOTIFY_EVENT = "animationNotify";

/** NpcLifecycleComponent spawn-enter notification (Phase 5). */
export const NPC_ENTER_EVENT = "npcEnter";

/** AnimationComponent -> anything caching the actor's mesh list (Phase 3). */
export const MESHES_CHANGED_EVENT = "meshesChanged";

/** UnrealScript native dispatch, handled by PawnMovementComponent among others (Phase 4). */
export const SCRIPT_NATIVE_EVENT = "scriptNative";

/** UnrealScript function call dispatch (Phase 4). */
export const SCRIPT_CALL_EVENT = "scriptCall";

/** PawnMovementComponent.teleportTo -> hair/water/landmark components (Phase 7). */
export const PAWN_TELEPORTED_EVENT = "pawnTeleported";
