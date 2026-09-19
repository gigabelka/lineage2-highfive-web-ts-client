/**
 * The paperdoll equipment model: a plain `slot -> display item id` record, nothing else.
 *
 * Deliberately free of three.js and of UE2 asset code so both graphs can import it (the renderer
 * that edits equipment and the decode worker that resolves it into mesh paths) - same contract as
 * `src/utils/`. The server only ever sends the item id per slot; which mesh that id maps to, and
 * therefore whether it replaces a body part or hangs off a bone, is resolved worker-side from
 * `armorgrp.dat` / `weapongrp.dat`.
 *
 * `EQUIPMENT_SLOTS` mirrors `GD.CharacterEquipmentSlot_T` in `index.d.ts` at runtime; keep the two
 * in sync (the type is what the compiler sees, this array is what the loops iterate).
 */

/* Body-replacing slots first - a mesh in one of these swaps a naked body part rather than being
   added beside it, which is what makes the order significant in a diff. */
export const EQUIPMENT_SLOTS: readonly GD.CharacterEquipmentSlot_T[] = [
  "chest",
  "legs",
  "gloves",
  "boots",
  "head",
  "cloak",
  "hair",
  "hair2",
  "rhand",
  "lhand",
] as const;

/** The slots that swap a naked body part - the only ones a character bundle can never carry. */
export const BODY_EQUIPMENT_SLOTS: readonly GD.CharacterEquipmentSlot_T[] = [
  "chest",
  "legs",
  "gloves",
  "boots",
] as const;

/**
 * Nothing equipped. Frozen because it is handed out as a default argument in several places - an
 * accidental write here would equip one slot on every character in the game (the shared
 * `BufferValue` poisoning bug, one layer up). Use `normalizeEquipment({})` when a mutable copy is
 * needed.
 */
export const NO_EQUIPMENT: GD.ICharacterEquipment = Object.freeze({
  chest: 0,
  legs: 0,
  gloves: 0,
  boots: 0,
  head: 0,
  cloak: 0,
  hair: 0,
  hair2: 0,
  rhand: 0,
  lhand: 0,
});

/** Fills in the slots a partial record leaves out, so the worker always sees all ten. */
export function normalizeEquipment(
  equipment?: Partial<GD.ICharacterEquipment>,
): GD.ICharacterEquipment {
  /* always a fresh object - never `NO_EQUIPMENT` itself, which is frozen precisely so this cannot
     be forgotten */
  const normalized = { ...NO_EQUIPMENT } as GD.ICharacterEquipment;

  if (equipment)
    for (const slot of EQUIPMENT_SLOTS) {
      const id = equipment[slot];

      normalized[slot] =
        typeof id === "number" && Number.isFinite(id) && id > 0
          ? Math.trunc(id)
          : 0;
    }

  return normalized;
}

/** `true` when no slot holds an item - the naked-body bundle can be used as-is. */
export function isEmptyEquipment(equipment: Partial<GD.ICharacterEquipment>): boolean {
  return !EQUIPMENT_SLOTS.some((slot) => (equipment[slot] ?? 0) !== 0);
}

/**
 * The slots that differ between two equipment records, in `EQUIPMENT_SLOTS` order. Both sides go
 * through `normalizeEquipment` first, so a missing slot and an explicit `0` compare equal.
 *
 * The incremental equipping path diffs on this rather than on the caller's intent: "took the chest
 * piece off" and "put a full-armour item on" both fall out of the same comparison.
 */
export function diffEquipment(
  a?: Partial<GD.ICharacterEquipment>,
  b?: Partial<GD.ICharacterEquipment>,
): GD.CharacterEquipmentSlot_T[] {
  const from = normalizeEquipment(a);
  const to = normalizeEquipment(b);

  return EQUIPMENT_SLOTS.filter((slot) => from[slot] !== to[slot]);
}
