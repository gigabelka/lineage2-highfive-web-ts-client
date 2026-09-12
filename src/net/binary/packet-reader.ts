/**
 * Little-endian binary reader over a packet body. Port of server-protocol.md's PacketReader
 * from Buffer to Uint8Array/DataView.
 *
 * Every read is bounds-checked. The doc's version would hand back `undefined` on a short
 * packet and the FSM would happily act on it; a malformed or truncated body is exactly the
 * failure we want loud, so it throws instead.
 */

const UTF16 = new TextDecoder("utf-16le");

export class PacketReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos: number;

  public constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  private need(n: number, what: string): number {
    const at = this.pos;

    if (at + n > this.bytes.length) {
      throw new RangeError(
        `PacketReader: need ${n} bytes for ${what} at offset ${at}, only ${this.bytes.length - at} left (body ${this.bytes.length} bytes)`,
      );
    }

    this.pos = at + n;
    return at;
  }

  public readUInt8(): number {
    return this.view.getUint8(this.need(1, "uint8"));
  }

  public readUInt16LE(): number {
    return this.view.getUint16(this.need(2, "uint16"), true);
  }

  public readInt16LE(): number {
    return this.view.getInt16(this.need(2, "int16"), true);
  }

  public readInt32LE(): number {
    return this.view.getInt32(this.need(4, "int32"), true);
  }

  public readUInt32LE(): number {
    return this.view.getUint32(this.need(4, "uint32"), true);
  }

  public readInt64LE(): bigint {
    return this.view.getBigInt64(this.need(8, "int64"), true);
  }

  public readFloatLE(): number {
    return this.view.getFloat32(this.need(4, "float"), true);
  }

  public readDoubleLE(): number {
    return this.view.getFloat64(this.need(8, "double"), true);
  }

  /** Returns a COPY of the next n bytes. */
  public readBytes(n: number): Uint8Array {
    const at = this.need(n, `${n} bytes`);
    return this.bytes.slice(at, at + n);
  }

  /** UTF-16LE up to (and consuming) the two-byte 0x0000 terminator. */
  public readStringUTF16(): string {
    let end = this.pos;

    while (end + 1 < this.bytes.length && !(this.bytes[end] === 0 && this.bytes[end + 1] === 0)) {
      end += 2;
    }

    if (end + 1 >= this.bytes.length && !(this.bytes[end] === 0 && this.bytes[end + 1] === 0)) {
      throw new RangeError(`PacketReader: unterminated UTF-16 string at offset ${this.pos}`);
    }

    const value = UTF16.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 2;

    return value;
  }

  public remaining(): number {
    return this.bytes.length - this.pos;
  }

  public get position(): number {
    return this.pos;
  }

  public skip(n: number): this {
    this.need(n, `skip(${n})`);
    return this;
  }

  /** The record layouts are long runs of padding ints; skipInt32(7) reads better than skip(28). */
  public skipInt32(count: number): this {
    return this.skip(count * 4);
  }

  public skipDouble(count: number): this {
    return this.skip(count * 8);
  }
}

export default PacketReader;
