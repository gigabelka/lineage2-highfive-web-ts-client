import { describe, expect, it } from "vitest";
import getNpcBundleName, { isNpcMeshPackage, NPC_MONSTERS_BUNDLE, NPC_NPCS_BUNDLE } from "./npc-bundle";

describe("getNpcBundleName", () => {
    it("maps every LineageMonsters package to the monsters bundle", () => {
        for (const name of ["LineageMonsters", "lineagemonsters2", "LineageMonsters3", "LineageMonsters4", "LineageMonsters5", "LineageMonsters6"])
            expect(getNpcBundleName(name)).toBe(NPC_MONSTERS_BUNDLE);
    });

    it("maps the NPC and deco packages to the npcs bundle", () => {
        for (const name of ["LineageNpcs", "LineageNPCs2", "LineageNPCsEV", "LineageDecos", "lineagenpcsev"])
            expect(getNpcBundleName(name)).toBe(NPC_NPCS_BUNDLE);
    });

    it("throws on a package outside either bundle", () => {
        expect(() => getNpcBundleName("LineageWeapons")).toThrow(/no bundle/);
        expect(() => getNpcBundleName("LineageAccessory")).toThrow(/no bundle/);
    });
});

describe("isNpcMeshPackage", () => {
    it("accepts the bundled packages and rejects the rest", () => {
        expect(isNpcMeshPackage("LineageMonsters6")).toBe(true);
        expect(isNpcMeshPackage("LineageDecos")).toBe(true);
        expect(isNpcMeshPackage("LineageWeapons")).toBe(false);
        expect(isNpcMeshPackage("SomeLevel")).toBe(false);
    });
});
