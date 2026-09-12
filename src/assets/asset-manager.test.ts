import { describe, expect, it } from "vitest";
import DecodeWorkerClient from "@client/assets/decode-worker/decode-worker-client";

/**
 * `AssetManager`'s character/NPC seam (`requireWorkerMethod`, see asset-manager.ts) looks up
 * these RPCs by name at call time rather than through the type system, so a rename on either side
 * silently turns into a runtime "not implemented" error instead of a compile error - this is
 * exactly the bug that broke the Character panel and NPC spawn (the RPC was renamed to
 * `decodeClientConfig` but the caller still asked for `getClientConfig`). Pin the names here so a
 * future rename fails a test instead of only failing at runtime.
 */
describe("DecodeWorkerClient RPC surface used by AssetManager.requireWorkerMethod", () => {
  it.each([
    "decodeClientConfig",
    "getCharGroups",
    "resolveNpc",
    "decodeCharacter",
    "decodeSkeletalMesh",
  ])("exposes %s()", (name) => {
    expect(typeof (DecodeWorkerClient.prototype as any)[name]).toBe(
      "function",
    );
  });
});
