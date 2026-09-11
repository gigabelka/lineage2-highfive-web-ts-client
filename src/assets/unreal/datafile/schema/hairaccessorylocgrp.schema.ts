import { SizedContainerType } from "./dat-container";

/* system/hairaccessorylocgrp.dat: bone-local attach transform per hair accessory, one
   float triple plus one int triple per slot 1..0xE. */
const SCHEMA_HAIRACCESSORYLOCGRP_DAT = [
    { type: "utf16", name: "name" }
] as ISchemaValue[];

for (let i = 0x1, suffix = i.toString(16); i < 0xF; i++) {
    SCHEMA_HAIRACCESSORYLOCGRP_DAT.push({ type: new SizedContainerType("float", 3), name: `floats_${suffix}` });
    SCHEMA_HAIRACCESSORYLOCGRP_DAT.push({ type: new SizedContainerType("int32", 3), name: `ints_${suffix}` });
}

export default SCHEMA_HAIRACCESSORYLOCGRP_DAT;
export { SCHEMA_HAIRACCESSORYLOCGRP_DAT };
