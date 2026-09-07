import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";

const ENV_INT = "c:/Games/HighFive/system/env.int";

vi.mock("@client/assets/asset-handle", () => {
    class ReadAssetHandle {
        readonly isReadable = true as const;
        constructor(public readonly buffer: ArrayBuffer) { }
        async getReadable() { return this; }
    }
    return {
        default: async (_path: string) => {
            const buf = fs.readFileSync(ENV_INT);
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            return new ReadAssetHandle(ab);
        }
    };
});

describe("env.int decode", () => {
    it("decodes [EnvSetup] section", async () => {
        const { default: UConfigEnv } = await import("./un-conf-env");

        const envFile: any = await (new (UConfigEnv as any)("assets/system/env.int").asReadable()).decode();

        console.log("contentOffset:", envFile.contentOffset);
        console.log("version:", envFile.version);
        console.log("buffer byteLength:", envFile.buffer?.byteLength);

        const text: string = envFile.decodeConfig();
        console.log("decoded length:", text.length);
        console.log("first 120:", JSON.stringify(text.slice(0, 120)));
        console.log("indexOf [EnvSetup]:", text.indexOf("[EnvSetup]"));
        console.log("indexOf [EnvSetup]\\r\\n:", text.indexOf("[EnvSetup]\r\n"));

        expect(text).toContain("[EnvSetup]\r\n");
    });
});
