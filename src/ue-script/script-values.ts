/**
 * Minimal value/call shapes for the UnrealScript bridge.
 *
 * The VM itself (`vm.ts`, `operators.ts`, `native-registry.ts`) lands in Phase 4. Until then
 * `BaseActor` and `PawnMovementComponent` only need the *types* so their script-bridge methods can
 * carry their final public signatures; nothing here executes bytecode. When Phase 4 ports `vm.ts`,
 * it should re-export these (or widen them) rather than introduce a second, incompatible set.
 *
 * Client graph only (see CLAUDE.md: `vm.ts` is client-side, `script-dump-loader.ts` is worker-side).
 */

export type Vector3Arr = [number, number, number];

export type ScriptHost_T = {
    scriptClassId: string;
    scriptProperties?: Map<string, ScriptValue_T>;
    getUnrealScriptProperty?(id: string): ScriptValue_T;
    setUnrealScriptProperty?(id: string, value: ScriptValue_T): void;
};

export type ScriptValue_T =
    | string
    | number
    | boolean
    | number[]
    | ScriptHost_T
    | Record<string, unknown>
    | null
    | undefined;

export type ScriptNativeCall_T = {
    index: number;
    name: string;
    args: ScriptValue_T[];
    self: ScriptHost_T;
    context: ScriptHost_T;
};
