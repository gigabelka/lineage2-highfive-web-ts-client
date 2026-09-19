import type UDataFile from "../un-datafile";
import {
    RaceColumnGapContainerType,
    RestOfRowContainerType,
    UTF16ContainerType,
} from "./dat-container";

/* chargrp.dat names a character by its class abbreviation (`mfighter` for a male human
   fighter); armorgrp.dat carries one mesh/texture column group per abbreviation.

   The insertion order IS the on-disk column order, and the columns are the first fifteen things
   after the row head - so this table is order-critical, and Kamael must stay last. C4 predates the
   race, so the donor has no entry for it; the column is real (a `Kamael.MKamael_m001_u` shows up in
   it for any item Kamael can wear), and reading it is what keeps the row aligned. */
const CHARACTER_ARMOR_GROUPS: Record<string, string> = {
    mfighter: "m_human_fighter",
    ffighter: "f_human_fighter",
    mdarkelf: "m_dark_elf",
    fdarkelf: "f_dark_elf",
    mdwarf: "m_dwarf",
    fdwarf: "f_dwarf",
    melf: "m_elf",
    felf: "f_elf",
    mmagic: "m_human_mystic",
    fmagic: "f_human_mystic",
    morc: "m_orc_fighter",
    forc: "f_orc_fighter",
    mshaman: "m_orc_mystic",
    fshaman: "f_orc_mystic",
    mkamael: "kamael"
};

/** The race column the C4 donor has no entry for; see the note on `CHARACTER_ARMOR_GROUPS`. */
const KAMAEL_ARMOR_GROUP = "kamael";

/* `armorgrp.dat`'s `body_part` codes. They are NOT the bit indices of the L2 slot mask
   (gloves is 20 here, not 9) - the codes were read off the file and each one is named by the mesh
   suffix it carries across all fifteen race columns and by the item's icon slot token, so the
   mapping is empirical but doubly corroborated:
     - 20/21/22/23 carry `_g`/`_u`/`_l`/`_b` meshes -> gloves/chest/legs/boots
     - 8 carries `_u` AND `_l` in one column   -> chest+legs as a single item
     - 9 carries `_u,_l,_g,_b` in one column   -> a whole set as a single item
     - 6 is the helmet/circlet family (icon tokens `armor_*_helmet`, `armor_circlet`)
     - 10/25 are head and per-race accessories (`_a` meshes out of Branch2 / LineageAccessory)
     - 24 is the cloak family (`armor_back*`, meshes out of LineageWeapons)
     - 19 is belts and shirts
   The two "single item covers several slots" codes have to be resolved by hand, not by a slot
   equality test - see `resolveCharacterParts` in the decode engine. */
const CHARACTER_ARMOR_SLOTS = { chest: 21, legs: 22, gloves: 20, boots: 23 };

/** A single item that covers chest and legs at once; also zeroes `legs`. */
const BODY_PART_FULL_ARMOR = 8;

/** A single item that covers chest, legs, gloves and boots at once. */
const BODY_PART_FULL_SET = 9;

/** Head items (`armor_leather_helmet`, `armor_circlet`, ...). See the note on `head` in the engine. */
const BODY_PART_HEAD = 6;

/** Head accessories (`br_royal_crown_of_vesper`, ...) and per-race accessories. */
const BODY_PART_HEAD_ACCESSORY = 10;
const BODY_PART_RACE_ACCESSORY = 25;

/** Cloaks (`armor_back*`). */
const BODY_PART_CLOAK = 24;

/** Belts and shirts. */
const BODY_PART_BELT = 19;

const SCHEMA_ARMORGRP_DAT: ISchemaValue[] = [
    { type: "uint32", name: "tag" },
    { type: "uint32", name: "id" },
    { type: "uint32", name: "drop_type" },
    { type: "uint32", name: "drop_anim_type" },
    { type: "uint32", name: "drop_radius" },
    { type: "uint32", name: "drop_height" },
    { type: "uint32", name: "unknown_0" },
    { type: "utf16", name: "drop_mesh_1" },
    { type: "utf16", name: "drop_mesh_2" },
    { type: "utf16", name: "drop_mesh_3" },
    { type: "utf16", name: "drop_texture_1" },
    { type: "utf16", name: "drop_texture_2" },
    { type: "utf16", name: "drop_texture_3" }
];

/* Nine uint32 the C4 donor does not have, between `drop_texture_3` and the icon strings. Their
   length is what matters (36 bytes, identical in armorgrp and weapongrp once the variable drop
   strings before them are accounted for); their meaning is unknown. On both files' first rows they
   are all zero except the seventh, which is 1. */
for (let i = 0; i < 9; i++)
    SCHEMA_ARMORGRP_DAT.push({ type: "uint32", name: `unknown_a_${i + 1}` });

SCHEMA_ARMORGRP_DAT.push(
    { type: "utf16", name: "icon" },
    { type: "utf16", name: "icon_2" },
    { type: "utf16", name: "icon_3" },
    { type: "utf16", name: "icon_4" },
    { type: "utf16", name: "icon_5" },

    { type: "int32", name: "durability" },
    { type: "uint32", name: "weight" },
    { type: "uint32", name: "material" },
    { type: "uint32", name: "crystallizable" },
    { type: "uint32", name: "property_params" },

    /* Two uint32 the donor folds into `body_part`, then the one *variable-length* field of the head.
       The variable one is what made the head look like a plain run of uint32: it is a zero-length
       FString on most rows (4 bytes, so a `uint32` read of it returns 0 and looks like a field) and
       carries `icon.time_tab` / `icon.*_panel` on ~600 rows. Reading the head as six fixed uint32 put
       `body_part` three words early - on row 0 that word is 0 while the true value, 21, sits 12 bytes
       later - which shifted every race column with it. */
    { type: "uint32", name: "unknown_b_0" },
    { type: "uint32", name: "unknown_b_1" },
    { type: "utf16", name: "icon_ext" },
    { type: "uint32", name: "body_part" }
);

for (const group of Object.values(CHARACTER_ARMOR_GROUPS)) {
    SCHEMA_ARMORGRP_DAT.push({ type: new UTF16ContainerType(), name: `${group}_mesh` });
    SCHEMA_ARMORGRP_DAT.push({ type: new UTF16ContainerType(), name: `${group}_texture` });

    /* The Kamael column carries the donor's extra mesh/texture pair straight after its texture (its
       strings do not decode with the same `uint32 length + bytes` shape the others use), so the gap
       after it is handled by the row-tail skip instead of by the column gap below. */
    if (group !== KAMAEL_ARMOR_GROUP)
        SCHEMA_ARMORGRP_DAT.push({ type: new RaceColumnGapContainerType(), name: `${group}_gap` });
}

/* The Kamael column's own mesh/texture pair is read (it is a normal race column for any item Kamael
   can wear); the extra pair that follows it is not - its strings do not decode with the same
   `uint32 length + bytes` shape the other columns use, and nothing in the app reads them. They fall
   into the skipped tail below. */

/* Everything after this point - the Kamael column's block and extra pair, the `npc_*`/`accessory_*`
   and the scalar tail - is not modelled. None of it is read by the renderer (the worn meshes are the
   race columns above), and the C4 donor's shape for it does not fit HighFive: reading it desyncs and
   costs the whole row. So the rest is skipped by resyncing to the next row start, which
   `armorgrpRowStartsAt` pins exactly on a value every row begins with. */
SCHEMA_ARMORGRP_DAT.push({ type: new RestOfRowContainerType(), name: "unreadTailBytes" });

/* Peek one `utf16` field at `at` and return the offset just past it, or -1 when it cannot be one. */
function skipUtf16(readable: UDataFile, at: number): number {
    const byteLength = readable.readPrimitive(at, 4).getUint32(0, true);

    if (byteLength === 0) return at + 4;
    if (byteLength % 2 !== 0 || byteLength > 512) return -1;

    try {
        readable.readPrimitive(at + 4, byteLength);
    } catch {
        return -1;
    }

    return at + 4 + byteLength;
}

/**
 * Row-start oracle for `UDataFile`, and - through `RestOfRowContainerType` - the definition of where a
 * row *ends*.
 *
 * The head walk below is what makes it discriminating: it consumes the whole head (six drop strings,
 * nine uint32, five icon strings) and then demands plausible durability/weight/material, so nothing
 * inside a row's own string data can pass. The one thing it must NOT key on is `drop_mesh_1` being a
 * `dropitems.` mesh: only 2777 of the file's 3650 rows carry one, the other 873 leave it empty. An
 * oracle that demanded it could not resync past those rows, which cost the table everything after
 * them. So an empty first drop mesh is accepted, and any *other* string there is not.
 */
function armorgrpRowStartsAt(readable: UDataFile, pos: number): boolean {
    const meshLen = readable.readPrimitive(pos + 28, 4).getUint32(0, true);

    if (meshLen % 2 !== 0 || meshLen > 512) return false;

    if (meshLen > 0) {
        const mesh = new TextDecoder("utf-16le").decode(
            readable.readPrimitive(pos + 32, Math.min(meshLen, 20)),
        );

        if (!mesh.startsWith("dropitems.")) return false;
    }

    let cursor = pos + 28; // seven uint32, then the drop mesh/texture strings

    for (let i = 0; i < 6; i++) {
        cursor = skipUtf16(readable, cursor);
        if (cursor < 0) return false;
    }

    cursor += 9 * 4; // the nine HighFive-only uint32 the head carries

    for (let i = 0; i < 5; i++) {
        cursor = skipUtf16(readable, cursor);
        if (cursor < 0) return false;
    }

    try {
        const durability = readable.readPrimitive(cursor, 4).getInt32(0, true);
        const weight = readable.readPrimitive(cursor + 4, 4).getUint32(0, true);
        const material = readable.readPrimitive(cursor + 8, 4).getUint32(0, true);

        if (!(durability >= -1 && durability <= 1_000_000)) return false;
        if (!(weight <= 10_000_000 && material <= 1000)) return false;
    } catch {
        return false;
    }

    return true;
}

export default SCHEMA_ARMORGRP_DAT;
export {
    SCHEMA_ARMORGRP_DAT,
    CHARACTER_ARMOR_GROUPS,
    CHARACTER_ARMOR_SLOTS,
    BODY_PART_FULL_ARMOR,
    BODY_PART_FULL_SET,
    BODY_PART_HEAD,
    BODY_PART_HEAD_ACCESSORY,
    BODY_PART_RACE_ACCESSORY,
    BODY_PART_CLOAK,
    BODY_PART_BELT,
    armorgrpRowStartsAt,
};
