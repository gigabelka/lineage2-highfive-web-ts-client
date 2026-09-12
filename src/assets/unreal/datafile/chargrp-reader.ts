import fetchAssetHandle from "@client/assets/asset-handle";
import { UEncodedFile } from "@l2js/core";
import { CHARGRP_RECORD_COUNT } from "./schema/chargrp.schema";

/*
 * system/chargrp.dat does not fit the declarative ISchemaValue[]/UDataFile model the other
 * .dat tables use. Its real layout (confirmed by decrypting the file and inspecting the
 * plaintext directly - see the "characters" branch plan) is:
 *
 *   - no inner signature/row-count and no leading face_icon/count fields - a row starts
 *     immediately with a large, variable-length run of individual 4-byte-length-prefixed
 *     UTF-16LE strings (hair mesh/texture path pairs interleaved with many zero-length
 *     "unused slot" placeholders). This run isn't modeled: decode-engine.ts never reads
 *     hair_mesh/hair_tex/face_icon/attack_eff/walkanimframe/any voice-sound field.
 *   - after that opaque run, the shape becomes genuinely self-describing: a uint32 count
 *     immediately followed by that many valid, printable, length-prefixed UTF-16 strings
 *     that look like asset paths. face_mesh and face_tex are two such groups back-to-back
 *     (count=3 in observed rows), immediately followed by four more back-to-back single-item
 *     groups - the four body_mesh[i]/body_tex[i] slots.
 *   - what follows the body slots (attack_eff, walkanimframe, per-weapon sound arrays) is
 *     unresolved, and doesn't need to be: rows are located by scanning for the
 *     "two adjacent valid counted-string-groups" signature rather than fixed offsets, so an
 *     unparsed tail is simply skipped by scanning forward for the next row's own signature.
 */

class ChargrpFile extends UEncodedFile {
  protected async readArrayBuffer() {
    const response = await fetchAssetHandle(this.path);
    const readable = await response.getReadable();

    return readable.buffer;
  }

  public toBuffer(): ArrayBuffer {
    throw new Error("Method not implemented.");
  }
}

/* tab/LF/CR or printable ASCII only, and looks like an asset path (has a package/object
   separator) - filters out garbage reads inside the opaque hair run from real path strings. */
function isPlausiblePathString(str: string): boolean {
  if (str.length === 0 || !str.includes(".") || !str.includes("_")) return false;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    if (code !== 0x09 && code !== 0x0a && code !== 0x0d && (code < 0x20 || code > 0x7e)) return false;
  }

  return true;
}

interface IGroupRead {
  items: string[];
  length: number;
}

/* one `uint32 count` followed by `count` length-prefixed utf16 asset-path strings, or null if
   anything at `byteOffset` doesn't match that shape. */
function readGroupAt(
  file: ChargrpFile,
  byteOffset: number,
  minItems: number,
  maxItems: number,
): IGroupRead | null {
  let count: number;

  try {
    count = file.readPrimitive(byteOffset, 4).getUint32(0, true);
  } catch {
    return null;
  }

  if (count < minItems || count > maxItems) return null;

  let cursor = byteOffset + 4;
  const items: string[] = [];

  for (let i = 0; i < count; i++) {
    let len: number;

    try {
      len = file.readPrimitive(cursor, 4).getUint32(0, true);
    } catch {
      return null;
    }

    if (len <= 0 || len > 4000 || len % 2 !== 0) return null;

    let str: string;

    try {
      str = new TextDecoder("utf-16").decode(file.readPrimitive(cursor + 4, len));
    } catch {
      return null;
    }

    if (!isPlausiblePathString(str)) return null;

    items.push(str);
    cursor += 4 + len;
  }

  return { items, length: cursor - byteOffset };
}

interface IDoubleGroupMatch {
  items1: string[];
  items2: string[];
  endOffset: number;
}

/* scans forward from `from` for the first position where two valid groups sit back-to-back -
   the signature that marks face_mesh+face_tex and each body_mesh[i]/body_tex[i] pair. The
   preceding opaque hair run has no embedded count values, so it can't spuriously match this.
   `group1Filter` narrows false positives further (e.g. a row's own unresolved combat-sound
   arrays, later in the same row, can otherwise look like a valid double-group too). */
function findDoubleGroup(
  file: ChargrpFile,
  from: number,
  maxScanBytes: number,
  minItems: number,
  maxItems: number,
  group1Filter?: (items: string[]) => boolean,
): IDoubleGroupMatch | null {
  for (let pos = from, end = from + maxScanBytes; pos < end; pos++) {
    const group1 = readGroupAt(file, pos, minItems, maxItems);

    if (!group1) continue;
    if (group1Filter && !group1Filter(group1.items)) continue;

    const group2 = readGroupAt(file, pos + group1.length, minItems, maxItems);

    if (!group2) continue;

    return { items1: group1.items, items2: group2.items, endOffset: pos + group1.length + group2.length };
  }

  return null;
}

/* every observed face_mesh/face_tex pair has exactly 3 items, all 3 of face_mesh identical -
   narrow enough to exclude both the single-item body-slot leftovers and the row's own 5-item
   combat-sound arrays, which otherwise also satisfy a looser "two adjacent groups" scan. */
function isFaceMeshGroup(items: string[]): boolean {
  return items.length === 3 && items.every((s) => s === items[0]);
}

const FACE_GROUP_SCAN_BYTES = 200_000;
const BODY_GROUP_SCAN_BYTES = 2000;

async function decodeCharGrpRows(path: string = "/assets/system/chargrp.dat"): Promise<Record<string, any>[]> {
  const file = await new ChargrpFile(path).asReadable().decode();

  const rows: Record<string, any>[] = [];
  let cursor = 0;

  for (let index = 0; index < CHARGRP_RECORD_COUNT; index++) {
    const face = findDoubleGroup(file, cursor, FACE_GROUP_SCAN_BYTES, 2, 4, isFaceMeshGroup);

    if (!face) {
      if (index === CHARGRP_RECORD_COUNT - 1) break;

      throw new Error(`Character group '${index}' is unexpectedly empty.`);
    }

    cursor = face.endOffset;

    const bodyMesh: string[] = [];
    const bodyTex: string[] = [];

    for (let slot = 0; slot < 4; slot++) {
      const pair = findDoubleGroup(file, cursor, BODY_GROUP_SCAN_BYTES, 1, 4);

      if (!pair) throw new Error(`Character group '${index}': body slot ${slot} not found.`);

      bodyMesh.push(pair.items1[0]);
      bodyTex.push(pair.items2[0]);
      cursor = pair.endOffset;
    }

    rows.push({
      face_mesh: face.items1,
      face_tex: face.items2,
      body_mesh: bodyMesh,
      body_tex: bodyTex,
    });
  }

  return rows;
}

export default decodeCharGrpRows;
export { decodeCharGrpRows };
