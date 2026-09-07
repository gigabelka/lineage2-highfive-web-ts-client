// Ambient augmentation of `@l2js/core`'s `UObject`.
//
// `src/assets/unreal/un-object-mixin.ts` attaches `uuid` / `dumpLayout` to
// `UObject.prototype` at runtime via `Object.defineProperty` / `Object.assign`;
// core's own typings don't know about them.
//
// The `make(...)` / `class()` statics are also injected at runtime (by the
// `onClassCreated` hook), but they land on every *subclass* individually, so they
// are declared per-class with `declare static` where they're used (the `F*` math
// structs in `src/assets/unreal/un-*.ts`).
//
// The augmentation targets the module where the class is physically declared
// (`.../un-object`); augmenting the `@l2js/core` barrel doesn't merge because the
// class is only re-exported from there.

// the top-level import makes this file a module, so `declare module` below *augments*
// the target module instead of declaring a fresh ambient one.
import type {} from "@l2js/core";

declare module "@l2js/core/src/unreal/un-object" {
    interface UObject {
        uuid: string;
        dumpLayout(): string;
    }
}
