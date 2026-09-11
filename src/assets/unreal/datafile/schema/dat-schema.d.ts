interface IDatContainerType {
    isContainerType: boolean;
    /** `values` holds the fields already read for the current row - sized containers look their count up there */
    read(pkg: C.UEncodedFile, values?: Record<string, any>): any;
}

interface ISchemaValue {
    type: C.ValidTypes_T<any> | IDatContainerType | C.ValueTypeNames_T | "ASCF",
    name: string,
    array?: boolean
}
