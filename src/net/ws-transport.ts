/**
 * Browser end of the TCP bridge (tools/tcp-bridge-plugin.ts).
 *
 * A WebSocket to the dev server carries raw TCP bytes, so WebSocket message boundaries are NOT
 * L2 frame boundaries - a message may hold several frames, a fraction of one, or both. All the
 * reassembly lives in `FrameReassembler`, kept separate from the socket so it can be tested
 * without one.
 */

const BRIDGE_PATH = "/l2-tcp";
const COMPACT_THRESHOLD = 1 << 16;

/**
 * Splits a raw TCP byte stream into L2 frames. Every packet on the wire is
 * `[uint16LE size][body...]` where the size INCLUDES the two size bytes, so a 5-byte packet
 * carries size 0x0005 and a 3-byte body.
 */
export class FrameReassembler {
  private buffer = new Uint8Array(0);
  private start = 0;

  /** Appends a chunk and returns every complete frame BODY it completed, in order. */
  public push(chunk: Uint8Array): Uint8Array[] {
    this.append(chunk);

    const frames: Uint8Array[] = [];

    for (;;) {
      const available = this.buffer.length - this.start;

      if (available < 2) break;

      const size = this.buffer[this.start] | (this.buffer[this.start + 1] << 8);

      /* A size below 2 cannot be a frame (the field includes itself) and would loop forever.
         It means the stream is desynchronised - almost always a crypto or framing bug - so it
         must be loud rather than silently skipped. */
      if (size < 2) {
        throw new Error(`FrameReassembler: impossible frame size ${size} - stream desynchronised`);
      }

      if (available < size) break;

      frames.push(this.buffer.slice(this.start + 2, this.start + size));
      this.start += size;
    }

    this.compact();

    return frames;
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    const merged = new Uint8Array(this.buffer.length - this.start + chunk.length);

    merged.set(this.buffer.subarray(this.start), 0);
    merged.set(chunk, this.buffer.length - this.start);

    this.buffer = merged;
    this.start = 0;
  }

  /** Drop consumed bytes, but only once they are worth the copy. */
  private compact(): void {
    if (this.start === 0) return;

    if (this.start === this.buffer.length) {
      this.buffer = new Uint8Array(0);
      this.start = 0;
      return;
    }

    if (this.start >= COMPACT_THRESHOLD) {
      this.buffer = this.buffer.slice(this.start);
      this.start = 0;
    }
  }

  public get pending(): number {
    return this.buffer.length - this.start;
  }
}

export interface L2ConnectionEvents {
  /** One complete frame body: opcode + payload, WITHOUT the 2-byte size. */
  onPacket: (body: Uint8Array) => void;
  onClose: (reason: string) => void;
  onError: (error: Error) => void;
}

export class L2Connection {
  private readonly socket: WebSocket;
  private readonly events: L2ConnectionEvents;
  private readonly reassembler = new FrameReassembler();
  private open = true;

  private constructor(socket: WebSocket, events: L2ConnectionEvents) {
    this.socket = socket;
    this.events = events;

    socket.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onMessage(e.data);
    socket.onclose = (e: CloseEvent) => {
      this.open = false;
      this.events.onClose(e.reason || `code ${e.code}`);
    };
    socket.onerror = () => {
      // The browser never exposes why; the dev-server log's [l2-tcp] line carries the detail.
      this.events.onError(new Error("websocket error (see the [l2-tcp] dev-server log)"));
    };
  }

  /**
   * Resolves once the bridge reports the TCP socket is up - the plugin defers the WebSocket
   * handshake until `net.Socket` fires `connect`, so `onopen` genuinely means "the L2 server
   * accepted us" rather than "the dev server accepted us".
   */
  public static open(host: string, port: number, events: L2ConnectionEvents): Promise<L2Connection> {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${location.host}${BRIDGE_PATH}?host=${encodeURIComponent(host)}&port=${port}`;
      const socket = new WebSocket(url);

      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        socket.onerror = null;
        resolve(new L2Connection(socket, events));
      };

      socket.onerror = () => {
        reject(new Error(`cannot reach ${host}:${port} through the dev-server bridge`));
      };
    });
  }

  /** Send a body (opcode + payload). The 2-byte LE length is prepended here, never by callers. */
  public send(body: Uint8Array): void {
    if (!this.open) throw new Error("L2Connection.send on a closed connection");

    const size = body.length + 2;
    const frame = new Uint8Array(size);

    frame[0] = size & 0xff;
    frame[1] = (size >>> 8) & 0xff;
    frame.set(body, 2);

    this.socket.send(frame);
  }

  public close(): void {
    this.open = false;
    this.socket.onclose = null;
    this.socket.close();
  }

  public get isOpen(): boolean {
    return this.open;
  }

  private onMessage(data: ArrayBuffer): void {
    let frames: Uint8Array[];

    try {
      frames = this.reassembler.push(new Uint8Array(data));
    } catch (e) {
      this.events.onError(e as Error);
      this.close();
      return;
    }

    for (const frame of frames) this.events.onPacket(frame);
  }
}

export default L2Connection;
