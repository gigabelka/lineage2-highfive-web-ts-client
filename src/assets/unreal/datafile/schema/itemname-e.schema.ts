/* system/itemname-e.dat: display names keyed by item id; `add_name` is the suffix that
   distinguishes otherwise-identical armour pieces. */
const SCHEMA_ITEMNAME_E_DAT = [
    { type: "uint32", name: "id" },
    { type: "utf16", name: "name" },
    { type: "utf16", name: "add_name" },
    { type: "ASCF", name: "description" },
    { type: "int32", name: "popup" }
] as ISchemaValue[];

export default SCHEMA_ITEMNAME_E_DAT;
export { SCHEMA_ITEMNAME_E_DAT };
