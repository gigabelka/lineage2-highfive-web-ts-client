/** Byte helpers shared by the net stack. No Buffer: this code runs in the browser. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;

  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** Lowercase hex, space-separated - for the packet trace logs. */
export function hex(bytes: Uint8Array, limit = bytes.length): string {
  const shown = bytes.subarray(0, limit);
  let out = "";

  for (let i = 0; i < shown.length; i++) {
    out += (i > 0 ? " " : "") + shown[i].toString(16).padStart(2, "0");
  }

  return shown.length < bytes.length ? `${out} …(+${bytes.length - shown.length})` : out;
}

export function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
