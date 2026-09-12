import net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { loadEnv, type Plugin } from "vite";

/**
 * Dev-only byte pipe between the browser and a Lineage 2 server's TCP port.
 *
 * The browser cannot open a TCP socket, so `src/net/ws-transport.ts` connects to
 * `ws://<dev server>/l2-tcp?host=..&port=..` and this plugin splices that WebSocket onto a
 * `net.Socket`. It is deliberately DUMB: it knows nothing about L2 framing, opcodes or crypto -
 * all of that lives in the browser under `src/net/`. Login and game are two sequential
 * connections, which is simply two sequential WebSockets; nothing here is stateful across them.
 */

const BRIDGE_PATH = "/l2-tcp";

/** RFC1918 + loopback. Keeps the dev server from being an open TCP proxy for any page. */
const PRIVATE_IPV4 =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function tcpBridgePlugin(): Plugin {
  return {
    name: "l2-tcp-bridge",
    // configureServer only runs in dev anyway; being explicit keeps it out of `vite build`.
    apply: "serve",

    configureServer(server) {
      const httpServer = server.httpServer;

      if (!httpServer) return; // middlewareMode: no server to hook an upgrade onto

      /* The allowlist is meaningful for a public-IP server too, but Vite's loadEnv is what
         populates L2_*; process.env does not carry the .env file. */
      const env = loadEnv(server.config.mode, server.config.root, "L2_");
      const configuredHost = env.L2_LOGIN_IP ?? "";

      const wss = new WebSocketServer({ noServer: true });

      const reject = (socket: Duplex, status: string, why: string): void => {
        console.warn(`[l2-tcp] rejected: ${why}`);
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };

      httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        /* Vite registers its own upgrade listener on this same server for HMR, and Node calls
           EVERY listener. Anything but a bare `return` on a path we do not own kills HMR. */
        let url: URL;

        try {
          url = new URL(req.url ?? "/", "http://localhost");
        } catch {
          return;
        }

        if (url.pathname !== BRIDGE_PATH) return;

        const host = url.searchParams.get("host") ?? "";
        const port = Number.parseInt(url.searchParams.get("port") ?? "", 10);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return reject(socket, "400 Bad Request", `bad port "${url.searchParams.get("port")}"`);
        }

        if (!IPV4.test(host) || (!PRIVATE_IPV4.test(host) && host !== configuredHost)) {
          return reject(
            socket,
            "403 Forbidden",
            `host "${host}" is neither private nor the configured L2_LOGIN_IP`,
          );
        }

        const tcp = net.connect({ host, port });
        tcp.setNoDelay(true);

        const onPreConnectError = (e: Error): void => {
          reject(socket, "502 Bad Gateway", `${host}:${port} - ${e.message}`);
        };

        tcp.once("error", onPreConnectError);

        /* Deferring the WebSocket handshake until TCP is up is what makes `ws.onopen` in the
           browser mean "the L2 server accepted us". Otherwise a refused server shows up as an
           FSM that hangs in WAIT_INIT forever instead of a visible failure. */
        tcp.once("connect", () => {
          tcp.off("error", onPreConnectError);
          wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, tcp, host, port));
        });
      });

      httpServer.on("close", () => wss.close());
    },
  };
}

function pipe(ws: WebSocket, tcp: net.Socket, host: string, port: number): void {
  const label = `${host}:${port}`;
  const startedAt = Date.now();
  let bytesIn = 0;
  let bytesOut = 0;
  let closed = false;

  console.info(`[l2-tcp] ${label} open`);

  const finish = (why: string): void => {
    if (closed) return;
    closed = true;

    console.info(
      `[l2-tcp] ${label} closed (${why}) after ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ` +
        `in ${formatBytes(bytesIn)} / out ${formatBytes(bytesOut)}`,
    );
  };

  tcp.on("data", (chunk: Buffer) => {
    bytesIn += chunk.length;
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });

  // No backpressure handling: the whole L2 handshake is well under 100 KB.
  ws.on("message", (data: Buffer) => {
    bytesOut += data.length;
    tcp.write(data);
  });

  tcp.on("close", () => {
    finish("tcp closed");
    if (ws.readyState === ws.OPEN) ws.close(1000, "tcp closed");
  });

  tcp.on("error", (e: Error) => {
    finish(`tcp error: ${e.message}`);
    if (ws.readyState === ws.OPEN) ws.close(1011, "tcp error");
  });

  ws.on("close", () => {
    finish("ws closed");
    tcp.destroy();
  });

  ws.on("error", (e: Error) => {
    finish(`ws error: ${e.message}`);
    tcp.destroy();
  });
}

export default tcpBridgePlugin;
