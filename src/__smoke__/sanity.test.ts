import { describe, it, expect } from "vitest";

/**
 * Smoke test — proves the Vitest runner, TS transform and alias resolution work.
 * Keep `npm test` green so the `implement` / `tdd` skills have a baseline.
 */
describe("vitest sanity", () => {
    it("runs", () => {
        expect(true).toBe(true);
    });
});
