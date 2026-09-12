/* system/entereventgrp.dat: NPC spawn/enter presentation - sound, effect, and the animation
   Npcgrp.dat's `tag` plays on spawn (a "rise from the ground" style entrance). */
const SCHEMA_ENTEREVENTGRP_DAT = [
    { type: "uint32", name: "id" },
    { type: "uint8", name: "UNK_0" },
    { type: "ASCF", name: "skill_sound" },
    { type: "float", name: "sound_vol" },
    { type: "float", name: "sound_rad" },
    { type: "uint32", name: "isrise" },
    { type: "uint32", name: "spawn_type" },
    { type: "utf16", name: "effect_name" },
    { type: "utf16", name: "anim_name" }
] as ISchemaValue[];

export default SCHEMA_ENTEREVENTGRP_DAT;
export { SCHEMA_ENTEREVENTGRP_DAT };
