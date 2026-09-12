import { ConstantValueType, RawStringRunType, ResyncingCountedArrayType } from "./dat-container";

/* system/chargrp.dat: no row count in the file, L2FileEdit's C4 chargrp.ddf RECCNT. */
const CHARGRP_RECORD_COUNT = 15;

const SCHEMA_CHARGRP_DAT = [
    { type: "utf16", name: "face_icon" },
    /* the ddf declares cnt_hm/cnt_ht/cnt_fm/cnt_ft + hair_mesh/hair_tex/face_mesh/face_tex/
       body_mesh[4]/body_tex[4]/attack_eff/walkanimframe here, but the real file doesn't carry
       those count fields at this position - see RawStringRunType's doc comment. Read as one
       opaque run of raw strings (undifferentiated hair/face/body mesh+texture paths, attack_eff,
       and a trailing walkanimframe that's indistinguishable from an empty-slot zero) until the
       genuine cnt_att field below, which does match the ddf. */
    { type: new RawStringRunType(), name: "unresolved_hair_face_body" },
    /* decode-engine.ts (getCharacterRow, getCharacterArmorGroup, resolveCharacterPartPaths) reads
       face_mesh/face_tex/body_mesh/body_tex by name and expects them to be arrays, but their real
       sub-boundaries inside unresolved_hair_face_body above aren't known yet (see that field's
       comment) - stub them as empty rather than leave them undefined, so that code's own
       `row.face_mesh.length === 0` checks take its existing "character group is empty" path
       instead of crashing on a missing property. This needs real decoding, not just a stub. */
    { type: new ConstantValueType<string[]>([]), name: "face_mesh" },
    { type: new ConstantValueType<string[]>([]), name: "face_tex" },
    { type: new ConstantValueType<string[]>([]), name: "body_mesh" },
    { type: new ConstantValueType<string[]>([]), name: "body_tex" },
    /* the ddf declares separate cnt_att/cnt_def/cnt_dmg/cnth/cnt1h/.../cntf UINT fields ahead of
       their arrays; the real file interleaves each count immediately with its own array instead
       (count, then that many utf16 strings) - see ResyncingCountedArrayType's doc comment for why
       these read the count themselves rather than taking it from a named sibling field. */
    { type: new ResyncingCountedArrayType(), name: "snd_att" },
    { type: new ResyncingCountedArrayType(), name: "snd_def" },
    { type: new ResyncingCountedArrayType(), name: "snd_dmg" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_hand" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_1hs" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_2hs" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_dual" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_pole" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_bow" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_unknown" },
    { type: new ResyncingCountedArrayType(), name: "voice_snd_fist" }
] as ISchemaValue[];

export default SCHEMA_CHARGRP_DAT;
export { CHARGRP_RECORD_COUNT, SCHEMA_CHARGRP_DAT };
