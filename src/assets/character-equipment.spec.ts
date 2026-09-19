import { describe, expect, it } from "vitest";

import {
  BODY_EQUIPMENT_SLOTS,
  EQUIPMENT_SLOTS,
  NO_EQUIPMENT,
  diffEquipment,
  isEmptyEquipment,
  normalizeEquipment,
} from "./character-equipment";

describe("EQUIPMENT_SLOTS", () => {
    it("covers all ten paperdoll slots exactly once", () => {
        expect(EQUIPMENT_SLOTS).toHaveLength(10);
        expect(new Set(EQUIPMENT_SLOTS).size).toBe(10);
    });

    it("matches the keys of ICharacterEquipment", () => {
        /* the array is the runtime mirror of the type - if the type gains a slot and this list is
           not updated, every loop over EQUIPMENT_SLOTS silently ignores it */
        const declared: Record<GD.CharacterEquipmentSlot_T, true> = {
            chest: true, legs: true, gloves: true, boots: true,
            head: true, cloak: true, hair: true, hair2: true,
            rhand: true, lhand: true,
        };

        expect([...EQUIPMENT_SLOTS].sort()).toEqual(Object.keys(declared).sort());
    });

    it("keeps the body-replacing slots a prefix of the full list", () => {
        /* diffEquipment and the assembly order both lean on this */
        expect(EQUIPMENT_SLOTS.slice(0, BODY_EQUIPMENT_SLOTS.length)).toEqual([
            ...BODY_EQUIPMENT_SLOTS,
        ]);
        expect(new Set(BODY_EQUIPMENT_SLOTS).size).toBe(BODY_EQUIPMENT_SLOTS.length);
    });
});

describe("normalizeEquipment", () => {
    it("fills every slot with 0 when handed nothing", () => {
        expect(normalizeEquipment()).toEqual(NO_EQUIPMENT);
        expect(normalizeEquipment(undefined)).toEqual(NO_EQUIPMENT);
    });

    it("keeps the four body slots the old callers send and zeros the rest", () => {
        expect(normalizeEquipment({ chest: 5, legs: 6, gloves: 7, boots: 8 })).toEqual({
            chest: 5, legs: 6, gloves: 7, boots: 8,
            head: 0, cloak: 0, hair: 0, hair2: 0, rhand: 0, lhand: 0,
        });
    });

    it("fills in the slots a partial record omits", () => {
        expect(normalizeEquipment({ rhand: 2365 })).toEqual({
            ...NO_EQUIPMENT,
            rhand: 2365,
        });
    });

    it("truncates fractional ids and drops anything that cannot be an item id", () => {
        const normalized = normalizeEquipment({
            chest: 12.9,
            legs: -3,
            gloves: NaN,
            head: Infinity,
            cloak: undefined,
        } as Partial<GD.ICharacterEquipment>);

        expect(normalized.chest).toBe(12);
        expect(normalized.legs).toBe(0);
        expect(normalized.gloves).toBe(0);
        expect(normalized.head).toBe(0);
        expect(normalized.cloak).toBe(0);
    });

    it("returns a fresh record, never the shared default", () => {
        /* mutating a normalised record must not equip the slot on every other character */
        const normalized = normalizeEquipment();

        normalized.chest = 100;

        expect(NO_EQUIPMENT.chest).toBe(0);
        expect(normalizeEquipment().chest).toBe(0);
    });

    it("freezes the shared default so it cannot be written through", () => {
        expect(() => {
            (NO_EQUIPMENT as { chest: number }).chest = 1;
        }).toThrow();
    });
});

describe("isEmptyEquipment", () => {
    it("is true for nothing equipped, absent slots and explicit zeros", () => {
        expect(isEmptyEquipment({})).toBe(true);
        expect(isEmptyEquipment(NO_EQUIPMENT)).toBe(true);
        expect(isEmptyEquipment({ chest: 0, rhand: 0 })).toBe(true);
    });

    it("is false as soon as any slot holds an item", () => {
        expect(isEmptyEquipment({ chest: 1 })).toBe(false);
        expect(isEmptyEquipment({ rhand: 2365 })).toBe(false);
        expect(isEmptyEquipment({ cloak: 70000 })).toBe(false);
    });
});

describe("diffEquipment", () => {
    it("reports nothing when the two sides agree once normalised", () => {
        expect(diffEquipment({ chest: 1 }, { chest: 1 })).toEqual([]);
        expect(diffEquipment({}, NO_EQUIPMENT)).toEqual([]);
        expect(diffEquipment(undefined, undefined)).toEqual([]);
        /* a slot left out and the same slot written as 0 are the same equipment */
        expect(diffEquipment({ chest: 0 }, {})).toEqual([]);
    });

    it("reports the slots that changed, in EQUIPMENT_SLOTS order", () => {
        expect(diffEquipment({ chest: 0 }, { chest: 1 })).toEqual(["chest"]);
        expect(
            diffEquipment(
                { chest: 1, legs: 2, rhand: 0 },
                { chest: 9, legs: 2, rhand: 2365 },
            ),
        ).toEqual(["chest", "rhand"]);
    });

    it("reports taking a piece off the same way as putting one on", () => {
        expect(diffEquipment({ chest: 42 }, {})).toEqual(["chest"]);
    });

    it("is symmetric", () => {
        const a = { chest: 1, head: 5 };
        const b = { chest: 2, rhand: 2365 };

        expect(diffEquipment(a, b)).toEqual(diffEquipment(b, a));
    });
});
