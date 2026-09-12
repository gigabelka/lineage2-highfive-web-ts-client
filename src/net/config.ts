/**
 * Live-server session config, read from the `L2_*` vars in the git-ignored `.env`
 * (exposed by `envPrefix` in vite.config.ts - see .env.example).
 *
 * `loadNetConfig` NEVER throws. A missing or malformed .env must not stop the renderer
 * from booting, so every failure degrades to `enabled: false` plus one console.warn.
 */

export interface NetConfig {
  /** False disables the whole network session; the client boots as the offline viewer it was. */
  enabled: boolean;
  loginHost: string;
  loginPort: number;
  /** Overrides the port advertised in ServerList - see `resolveGameHost` in login-client.ts. */
  gamePort: number;
  username: string;
  password: string;
  serverId: number;
  charSlot: number;
  protocol: number;
  /** Client-initiated keepalive interval; on this server the client pings, see opcodes.ts. */
  pingMs: number;
}

function num(raw: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (raw === undefined || raw === "") return fallback;

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value)) {
    problems.push(`${name}="${raw}" is not an integer`);
    return fallback;
  }

  return value;
}

export function loadNetConfig(): NetConfig {
  const env = import.meta.env;
  const problems: string[] = [];

  const config: NetConfig = {
    enabled: false,
    loginHost: env.L2_LOGIN_IP ?? "",
    loginPort: num(env.L2_LOGIN_PORT, 2106, "L2_LOGIN_PORT", problems),
    gamePort: num(env.L2_GAME_PORT, 7777, "L2_GAME_PORT", problems),
    username: env.L2_USERNAME ?? "",
    password: env.L2_PASSWORD ?? "",
    serverId: num(env.L2_SERVER_ID, 1, "L2_SERVER_ID", problems),
    charSlot: num(env.L2_CHAR_SLOT, 0, "L2_CHAR_SLOT", problems),
    protocol: num(env.L2_PROTOCOL, 267, "L2_PROTOCOL", problems),
    pingMs: num(env.L2_PING_MS, 30000, "L2_PING_MS", problems),
  };

  if (!config.loginHost) problems.push("L2_LOGIN_IP is not set");
  if (!config.username) problems.push("L2_USERNAME is not set");

  /* `?nonet` is what keeps every existing offline workflow (debug camera presets, manual sector
     poking) reachable on a machine that does have a working .env. */
  const disabledByUrl =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("nonet");

  // Credentials ride the bundle via envPrefix, so the session is dev-only by construction.
  config.enabled = env.DEV && problems.length === 0 && !disabledByUrl;

  if (problems.length > 0) {
    console.warn(
      `[net] session disabled - copy .env.example to .env and fix: ${problems.join("; ")}`,
    );
  } else if (disabledByUrl) {
    console.info("[net] session disabled by ?nonet");
  }

  return config;
}

export default loadNetConfig;
