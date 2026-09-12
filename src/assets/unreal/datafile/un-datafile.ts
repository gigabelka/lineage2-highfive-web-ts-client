
import fetchAssetHandle from "@client/assets/asset-handle";
import { UEncodedFile, BufferValue } from "@l2js/core";
import { ASCFType } from "./schema/dat-container";

/* Checks whether `pos` (content-relative) looks like the start of a row - used to resync past a
   row the schema does not (fully) model instead of giving up on the rest of the table. Must not
   consume the reader (peek only, e.g. via `UDataFile.readPrimitive`). */
type RowOracle_T = (readable: UDataFile, pos: number) => boolean;

/* Bounded so a table with no recognizable row ever left (corrupt file, wrong schema entirely)
   fails in milliseconds instead of scanning to EOF one byte at a time. */
const RESYNC_SCAN_WINDOW = 8192;

class UDataFile extends UEncodedFile {
    public datarows: Record<string, any>[];
    /* true when at least one row did not fit the schema - either skipped (resynced past) or, with
       no oracle to resync by, ending the table early. Callers should say the table is incomplete
       rather than trust `datarows.length` as the whole story. See the warnings in `decode()`. */
    public partial = false;
    public readonly schema: readonly ISchemaValue[];
    /* a few C4 tables (chargrp.dat) carry no row count of their own */
    protected readonly recordCount: number | null;
    /* Optional: recognizes a row's own start, so a row that does not fit `schema` (a HighFive
       column this port has not modelled yet, e.g. an extra field only some NPCs carry) costs only
       itself - the reader skips forward to the next row instead of truncating the whole table. */
    protected readonly resync?: RowOracle_T;

    public constructor(
        schema: ISchemaValue[],
        path: string,
        recordCount: number | null = null,
        resync?: RowOracle_T,
    ) {
        super(path);

        this.schema = schema;
        this.recordCount = recordCount;
        this.resync = resync;
    }

    /* Scan forward from `from` for the next position `this.resync` accepts as a row start, bounded
       by `RESYNC_SCAN_WINDOW`. Returns null if none is found (a corrupt file, or a schema that
       fits nothing past this point) - the caller then falls back to truncating the table. */
    protected findNextRow(from: number): number | null {
        if (!this.resync) return null;

        for (let pos = from; pos < from + RESYNC_SCAN_WINDOW; pos++) {
            try {
                if (this.resync(this, pos)) return pos;
            } catch {
                // out of bounds this near EOF - stop rather than keep probing past the buffer
                return null;
            }
        }

        return null;
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
            const rowStart = readable.tell();
            const values = {} as Record<string, any>;

            try {
                for (const { type, name } of this.schema) {
                    values[name] = loadSingleValue(readable, type, values);
                }
            } catch (e) {
                /* some rows carry per-class fields the schema doesn't yet model (observed on
                   Npcgrp.dat: an extra field some entries carry that others don't). With a row
                   oracle, skip forward to the next recognizable row instead of losing the rest of
                   the table over one unmodelled row; without one, there is no length prefix to
                   resync from, so it costs the rest of the table. Either way `partial` says the
                   schema does not (fully) fit this file, instead of `rows.length` quietly reading
                   as "this table has N entries". */
                const nextRow = this.findNextRow(rowStart + 1);

                this.partial = true;

                if (nextRow === null) {
                    console.warn(`UDataFile '${this.path}': row ${i}/${rowCount} failed to decode, keeping the ${rows.length} row(s) decoded so far.`, e);
                    break;
                }

                console.warn(`UDataFile '${this.path}': row ${i}/${rowCount} did not fit the schema, skipping ${nextRow - rowStart}B to the next row.`, e);
                readable.seek(nextRow, "set");
                continue;
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

        /* `utf16` (and `char`) size themselves off a length prefix in the buffer, so `read("utf16")`
           - which reuses one BufferValue instance per type name for the whole process - mutates that
           shared instance's declared size before it can fail on a garbage length. `readValue` now
           restores it on throw (see buffer-value.ts), but reading through a fresh instance here means
           a bad row never touches the shared one to begin with. */
        if (type === "utf16") return readable.read(new BufferValue(BufferValue.utf16)).value as any;

        const schemaValue = readable.read(type as any);
        const value = schemaValue;

        return value as any;
    } else if (!(type as IDatContainerType).isContainerType) {
        const schemaValue = readable.read(new BufferValue(type as C.ValidTypes_T<C.ValueTypeNames_T>));
        const value = schemaValue.value;

        return value as any;
    } else return (type as IDatContainerType).read(readable, values);
}