import { BufferValue } from "@l2js/core";
import type UDataFile from "../un-datafile";
import {
    ASCFArrayContainerType,
    ConditionalContainerType,
    NumberContainerType,
    UTF16ContainerType,
} from "./dat-container";

/* HighFive's Npcgrp.dat carries two layout deltas from the Chronicle 4 column list this was
   ported from (derived 2026-09-12 against c:/Games/HighFive/system/Npcgrp.dat, archiveVersion
   413):
     - `levelLimLo`/`levelLimHi` (two flat uint32) are replaced by two `NumberContainerType`
       arrays (`UNK2`/`UNK2b`), each gated by `UNK1`: present (compat32-counted uint32[]) only
       when `UNK1 === 0`, absent (zero bytes, not an empty array) for every other value observed.
     - after `classLim`, HighFive appends a uint32-counted array of ASCF dialogue/greeting lines
       (`dialogue`) and a trailing uint32 (`UNK4`).
   A handful of rows (raid bosses observed so far, e.g. tag 25035 "vale_master_50_bi") carry at
   least one more field this schema does not model yet - `SCHEMA_NPCGRP_DAT_RESYNC` below skips
   those rather than losing the rest of the table; extend the schema in place as more of them are
   worked out (see tools/dat-bytes.ts's `rows` command). */
const SCHEMA_NPCGRP_DAT = [
    { type: "uint32", name: "tag" },
    { type: "utf16", name: "class" },
    { type: "utf16", name: "mesh" },
    { type: new UTF16ContainerType(), name: "tex1" },
    { type: new UTF16ContainerType(), name: "tex2" },
    { type: new NumberContainerType(BufferValue.uint32), name: "dtab" },
    { type: "float", name: "npc_speed" },
    { type: "uint32", name: "UNK0" },
    { type: new UTF16ContainerType(), name: "sound1" },
    { type: new UTF16ContainerType(), name: "sound2" },
    { type: new UTF16ContainerType(), name: "sound3" },
    { type: "uint32", name: "UNK1" },
    {
        type: new ConditionalContainerType("UNK1", 0, new NumberContainerType(BufferValue.uint32)),
        name: "UNK2",
    },
    {
        type: new ConditionalContainerType("UNK1", 0, new NumberContainerType(BufferValue.uint32)),
        name: "UNK2b",
    },
    { type: "utf16", name: "effect" },
    { type: "uint32", name: "UNK3" },
    { type: "float", name: "soundRadius" },
    { type: "float", name: "soundVolume" },
    { type: "float", name: "soundRandom" },
    { type: "uint32", name: "quest" },
    { type: "uint32", name: "classLim" },
    { type: new ASCFArrayContainerType(), name: "dialogue" },
    { type: "uint32", name: "UNK4" },
] as ISchemaValue[];

/* Row-start oracle for `UDataFile`'s resync fallback: every Npcgrp class name observed is
   "LineageMonster.<...>", a short ASCII identifier. */
function npcgrpRowStartsAt(readable: UDataFile, pos: number): boolean {
    const tag = readable.readPrimitive(pos, 4).getUint32(0, true);

    if (tag === 0 || tag > 200000) return false;

    const classLen = readable.readPrimitive(pos + 4, 4).getUint32(0, true);

    if (classLen < 32 || classLen > 256) return false; // "LineageMonster." alone is 30 bytes

    const bytes = readable.readPrimitive(pos + 8, classLen);
    const text = new TextDecoder("utf-16le").decode(bytes);

    return text.startsWith("LineageMonster.");
}

export default SCHEMA_NPCGRP_DAT;
export { SCHEMA_NPCGRP_DAT, npcgrpRowStartsAt };
