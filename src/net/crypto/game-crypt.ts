/**
 * HighFive game-server 16-byte shifting XOR cipher. Key = the 8-byte XOR key from CryptInit
 * plus a fixed static tail. Verbatim from server-protocol.md.
 *
 * Enabled only when CryptInit's encryption flag is non-zero. On the target server that flag
 * is `ServerConfig.PACKET_ENCRYPTION` (gameserver/network/serverpackets/KeyPacket.java), which
 * defaults to false and is not set in this install's .ini - so the game stream is plaintext
 * today. The server gates its own Encryption on the exact same config
 * (gameserver/network/GameClient.java enableCrypt), so honouring the flag is correct and this
 * class simply stays dormant until someone flips PacketEncryption=True.
 */

const STATIC_TAIL = new Uint8Array([0xc8, 0x27, 0x93, 0x01, 0xa1, 0x6c, 0x31, 0x97]);

export class GameCrypt {
  private keyIn = new Uint8Array(16); // server -> client
  private keyOut = new Uint8Array(16); // client -> server
  private enabled = false;

  public init(xorKey: Uint8Array, enable: boolean): void {
    const full = new Uint8Array(16);

    full.set(xorKey.subarray(0, 8), 0);
    full.set(STATIC_TAIL, 8);

    this.keyIn = full.slice();
    this.keyOut = full.slice();
    this.enabled = enable;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public decrypt(data: Uint8Array): Uint8Array {
    if (!this.enabled) return data;

    const out = data.slice();
    const size = out.length;
    let xor = 0;

    for (let i = 0; i < size; i++) {
      const enc = out[i] & 0xff;
      out[i] = (enc ^ this.keyIn[i & 15] ^ xor) & 0xff;
      xor = enc;
    }

    this.shift(this.keyIn, size);

    return out;
  }

  public encrypt(data: Uint8Array): Uint8Array {
    if (!this.enabled) return data;

    const out = data.slice();
    const size = out.length;
    let enc = 0;

    for (let i = 0; i < size; i++) {
      enc = ((out[i] & 0xff) ^ this.keyOut[i & 15] ^ enc) & 0xff;
      out[i] = enc;
    }

    this.shift(this.keyOut, size);

    return out;
  }

  /** Advance bytes 8..11 of the key (little-endian uint32) by the packet size. */
  private shift(key: Uint8Array, size: number): void {
    let v = key[8] | (key[9] << 8) | (key[10] << 16) | (key[11] << 24);

    v = (v + size) >>> 0;

    key[8] = v & 0xff;
    key[9] = (v >>> 8) & 0xff;
    key[10] = (v >>> 16) & 0xff;
    key[11] = (v >>> 24) & 0xff;
  }
}

export default GameCrypt;
