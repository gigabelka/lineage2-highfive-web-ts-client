/* system/hairgrp.dat: 15 rows, one per character group, each a 6x10 mesh/style lookup
   table of the voice/face-flag bytes the original client tests. */
const HAIRGRP_RECORD_COUNT = 15;
const SCHEMA_HAIRGRP_DAT = [] as ISchemaValue[];

for (let mesh = 0; mesh < 6; mesh++) {
    for (let variant = 0; variant < 10; variant++) {
        SCHEMA_HAIRGRP_DAT.push({ type: "int8", name: `m${mesh}_a${variant}` });
        SCHEMA_HAIRGRP_DAT.push({ type: "int8", name: `m${mesh}_b${variant}` });
    }
}

export default SCHEMA_HAIRGRP_DAT;
export { HAIRGRP_RECORD_COUNT, SCHEMA_HAIRGRP_DAT };
