
import fetchAssetHandle from "@client/assets/asset-handle";
import { UEncodedFile, BufferValue } from "@l2js/core";
import { ASCFType } from "./schema/dat-container";

class UDataFile extends UEncodedFile {
    public datarows: Record<string, any>[];
    public readonly schema: readonly ISchemaValue[];
    /* a few C4 tables (chargrp.dat) carry no row count of their own */
    protected readonly recordCount: number | null;

    public constructor(schema: ISchemaValue[], path: string, recordCount: number | null = null) {
        super(path);

        this.schema = schema;
        this.recordCount = recordCount;
    }

    protected async readArrayBuffer() {
        const response = await fetchAssetHandle(this.path);
        const readable = await response.getReadable();

        return readable.buffer;
    }

    public toBuffer(): ArrayBuffer { throw new Error("Method not implemented."); }

    public async decode(): Promise<this> {
        await super.decode();

        const readable = this.asReadable();
        const signature = this.signature;

        if (signature !== 0x69004c)
            throw new Error(`Invalid signature: '0x${signature.toString(16).toUpperCase()}' expected '0x9E2A83C1'`);

        const rowCount = this.recordCount === null ? readable.read("uint32") : this.recordCount;
        const rows = [] as Record<string, any>[];

        for (let i = 0; i < rowCount; i++) {
            const values = {} as Record<string, any>;

            try {
                for (const { type, name } of this.schema) {
                    values[name] = loadSingleValue(readable, type, values);
                }
            } catch (e) {
                /* some rows carry per-class fields the schema doesn't yet model (e.g. chargrp.dat's
                   attack-sound counts, which aren't consistently laid out row-to-row - see
                   RawStringRunType/ResyncingCountedArrayType in ./schema/dat-container.ts) - stop
                   with whatever earlier rows decoded cleanly rather than throwing the whole table away. */
                console.warn(`UDataFile '${this.path}': row ${i}/${rowCount} failed to decode, keeping the ${rows.length} row(s) decoded so far.`, e);
                break;
            }

            rows.push(values);
        }

        this.datarows = rows;

        return this;
    }
}

export default UDataFile;

function loadSingleValue(readable: UDataFile, type: C.ValidTypes_T<any> | IDatContainerType | C.ValueTypeNames_T | "ASCF", values: Record<string, any>) {
    if (typeof type === "string") {
        if (type === "ASCF") return new ASCFType().read(readable);

        const schemaValue = readable.read(type as any);
        const value = schemaValue;

        return value as any;
    } else if (!(type as IDatContainerType).isContainerType) {
        const schemaValue = readable.read(new BufferValue(type as C.ValidTypes_T<C.ValueTypeNames_T>));
        const value = schemaValue.value;

        return value as any;
    } else return (type as IDatContainerType).read(readable, values);
}