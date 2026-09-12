/**
 * Little-endian binary writer. Port of server-protocol.md's PacketWriter, backed by a
 * growable Uint8Array instead of a chunk list (one fewer concat pass, and no Buffer).
 *
 * `toBytes()` returns the packet BODY - opcode + payload, WITHOUT the 2-byte length prefix.
 * L2Connection.send() prepends the length; never do it here (server-protocol.md
 * TROUBLESHOOTING, "send() writes garbage").
 */

const UTF16_ENCODE_CHUNK = 0x1000;

export class PacketWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private len = 0;

  public constructor(opcode?: number) {
    this.bytes = new Uint8Array(64);
    this.view = new DataView(this.bytes.buffer);
    if (opcode !== undefined) this.writeUInt8(opcode);
  }

  private reserve(n: number): number {
    const at = this.len;
    const needed = at + n;

    if (needed > this.bytes.length) {
      let capacity = this.bytes.length * 2;
      while (capacity < needed) capacity *= 2;

      const grown = new Uint8Array(capacity);
      grown.set(this.bytes.subarray(0, at));

      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }

    this.len = needed;
    return at;
  }

  /* Every writer below MUST call reserve() into a local before touching this.view/this.bytes:
     reserve() replaces both when it grows, and `this.view.setX(this.reserve(n), ...)` evaluates
     `this.view` BEFORE the argument, so it would write through the pre-grow view. That is a
     silent corruption for small packets and a RangeError for large ones (RequestAuthLogin is
     176 bytes against a 64-byte initial capacity). */

  public writeUInt8(v: number): this {
    const at = this.reserve(1);
    this.view.setUint8(at, v & 0xff);
    return this;
  }

  public writeUInt16LE(v: number): this {
    const at = this.reserve(2);
    this.view.setUint16(at, v & 0xffff, true);
    return this;
  }

  public writeInt32LE(v: number): this {
    const at = this.reserve(4);
    this.view.setInt32(at, v | 0, true);
    return this;
  }

  public writeInt64LE(v: bigint): this {
    const at = this.reserve(8);
    this.view.setBigInt64(at, v, true);
    return this;
  }

  public writeDoubleLE(v: number): this {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
    return this;
  }

  public writeBytes(b: Uint8Array): this {
    const at = this.reserve(b.length);
    this.bytes.set(b, at);
    return this;
  }

  /** The mandatory zero blocks: 14 after the char slot, 43 in RequestAuthLogin, 104 in EnterWorld. */
  public writeZeros(n: number): this {
    this.reserve(n); // the backing array is already zero-filled where it has never been written
    this.bytes.fill(0, this.len - n, this.len);
    return this;
  }

  public writeStringNullUTF16(s: string): this {
    for (let i = 0; i < s.length; i += UTF16_ENCODE_CHUNK) {
      const chunk = s.slice(i, i + UTF16_ENCODE_CHUNK);
      const at = this.reserve(chunk.length * 2);
      for (let j = 0; j < chunk.length; j++) this.view.setUint16(at + j * 2, chunk.charCodeAt(j), true);
    }

    return this.writeUInt16LE(0);
  }

  /** Packet body: opcode + payload, no length prefix. */
  public toBytes(): Uint8Array {
    return this.bytes.slice(0, this.len);
  }

  public get length(): number {
    return this.len;
  }
}

/**
 * A client extended packet: `0xD0` followed by a 2-byte little-endian sub-opcode.
 * RequestKeyMapping is `D0 21 00` (gameserver/network/ExClientPackets.java REQUEST_KEY_MAPPING).
 */
export function extended(subOpcode: number): PacketWriter {
  return new PacketWriter(0xd0).writeUInt16LE(subOpcode);
}

export default PacketWriter;
