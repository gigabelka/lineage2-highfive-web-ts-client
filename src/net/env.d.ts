/**
 * Types for the `L2_*` variables exposed through `envPrefix` in vite.config.ts.
 *
 * Deliberately NOT `/// <reference types="vite/client" />` and NOT `"types": ["vite/client"]`
 * in tsconfig.json: that pulls ambient module declarations for `*.glsl`/`*.vs`/`*.fs`, which
 * conflict with the string-default contract `rawShadersPlugin` provides for those imports.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;

  readonly L2_LOGIN_IP?: string;
  readonly L2_LOGIN_PORT?: string;
  readonly L2_GAME_PORT?: string;
  readonly L2_USERNAME?: string;
  readonly L2_PASSWORD?: string;
  readonly L2_SERVER_ID?: string;
  readonly L2_CHAR_SLOT?: string;
  readonly L2_PROTOCOL?: string;
  readonly L2_PING_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
