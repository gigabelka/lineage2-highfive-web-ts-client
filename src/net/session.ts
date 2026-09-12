/**
 * Orchestrates the two stages (login server, then game server) and exposes a single snapshot
 * of "where are we and where is the character" for the HUD and the world bridge.
 *
 * Nothing here touches three.js. `src/game/net-world-bridge.ts` is the only place that joins
 * this to the renderer.
 */

import type { CharSelectedBrief } from "@client/net/parsers/char-selected";
import type { CharacterInfo } from "@client/net/parsers/char-selection-info";
import type { NetConfig } from "@client/net/config";
import type { UserInfoBrief } from "@client/net/parsers/user-info";
import { GameClient } from "@client/net/game-client";
import { coordToTile } from "@client/net/world-tile";
import { runLogin } from "@client/net/login-client";

export type SessionPhase =
  | "IDLE"
  | "CONNECTING_LOGIN"
  | "AUTHENTICATING"
  | "CONNECTING_GAME"
  | "ENTERING_WORLD"
  | "IN_GAME"
  | "DISCONNECTED"
  | "FAILED";

/** Later sources win; `userInfo` is authoritative and is never overridden. */
export type CoordSource = "charList" | "charSelected" | "userInfo";

const COORD_PRIORITY: Record<CoordSource, number> = { charList: 1, charSelected: 2, userInfo: 3 };

export interface SessionSnapshot {
  phase: SessionPhase;
  detail: string;
  charName: string | null;
  objectId: number | null;
  coords: { x: number; y: number; z: number } | null;
  coordSource: CoordSource | null;
  tile: string | null;
  lastPongAt: number | null;
  gameTime: number | null;
}

export interface SessionHandlers {
  onSnapshot?(snapshot: SessionSnapshot): void;
  /** Called whenever a better coordinate source arrives. */
  onPlace?(x: number, y: number, z: number, source: CoordSource): void;
}

export class L2Session {
  private readonly cfg: NetConfig;
  private readonly handlers: SessionHandlers;

  private game: GameClient | null = null;
  private stopped = false;

  private current: SessionSnapshot = {
    phase: "IDLE",
    detail: "",
    charName: null,
    objectId: null,
    coords: null,
    coordSource: null,
    tile: null,
    lastPongAt: null,
    gameTime: null,
  };

  public constructor(cfg: NetConfig, handlers: SessionHandlers = {}) {
    this.cfg = cfg;
    this.handlers = handlers;
  }

  public get snapshot(): SessionSnapshot {
    return this.current;
  }

  /** Fire-and-forget. Never throws and never rejects: failures land in the snapshot. */
  public start(): void {
    this.stopped = false;
    void this.run();
  }

  public stop(): void {
    this.stopped = true;
    this.game?.stop();
    this.game = null;
  }

  public restart(): void {
    this.stop();
    this.patch({
      phase: "IDLE",
      detail: "",
      coords: null,
      coordSource: null,
      tile: null,
      lastPongAt: null,
    });
    this.start();
  }

  private patch(fields: Partial<SessionSnapshot>): void {
    this.current = { ...this.current, ...fields };
    this.handlers.onSnapshot?.(this.current);
  }

  private place(x: number, y: number, z: number, source: CoordSource): void {
    const previous = this.current.coordSource;

    if (previous !== null && COORD_PRIORITY[source] < COORD_PRIORITY[previous]) return;

    this.patch({ coords: { x, y, z }, coordSource: source, tile: coordToTile(x, y).id });
    this.handlers.onPlace?.(x, y, z, source);
  }

  private async run(): Promise<void> {
    try {
      this.patch({ phase: "CONNECTING_LOGIN", detail: `${this.cfg.loginHost}:${this.cfg.loginPort}` });

      const login = await runLogin(this.cfg, (state) => {
        if (state === "WAIT_LOGIN_OK") this.patch({ phase: "AUTHENTICATING", detail: this.cfg.username });
      });

      if (this.stopped) return;

      this.patch({ phase: "CONNECTING_GAME", detail: `${login.gameHost}:${login.gamePort}` });

      const game = new GameClient(
        this.cfg,
        { ...login, username: this.cfg.username },
        {
          onState: (state) => {
            if (state === "WAIT_USER_INFO") this.patch({ phase: "ENTERING_WORLD", detail: "" });
          },
          onCharList: (chars: CharacterInfo[], slot: number) => {
            const chosen = chars[slot];
            if (!chosen) return;

            this.patch({ charName: chosen.name, objectId: chosen.objectId });
            this.place(chosen.x, chosen.y, chosen.z, "charList");
          },
          onCharSelected: (char: CharSelectedBrief) => {
            this.patch({ charName: char.name, objectId: char.objectId });
            this.place(char.x, char.y, char.z, "charSelected");
          },
          onUserInfo: (info: UserInfoBrief) => {
            this.patch({ charName: info.name, objectId: info.objectId });
            this.place(info.x, info.y, info.z, "userInfo");
          },
          onPong: (gameTime) => this.patch({ lastPongAt: Date.now(), gameTime }),
          onDisconnect: (reason) => {
            if (!this.stopped) this.patch({ phase: "DISCONNECTED", detail: reason });
          },
        },
      );

      this.game = game;

      await game.start();

      if (this.stopped) return game.stop();

      this.patch({ phase: "IN_GAME", detail: "" });
      console.info("IN_GAME");
    } catch (e) {
      if (this.stopped) return;

      const message = (e as Error).message;

      console.error(`[net] session failed: ${message}`);
      this.patch({ phase: "FAILED", detail: message });
    }
  }
}

export default L2Session;
