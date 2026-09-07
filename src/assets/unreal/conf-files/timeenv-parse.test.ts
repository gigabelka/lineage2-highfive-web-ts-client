import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { consumeNextValue, consumeRGB, findSection } from "./conf-parser";

function decryptEucKr(file: string): string {
    const buf = fs.readFileSync(file);
    const HEADER_SIZE = 28, key = 0xAC;
    const body = Buffer.from(buf.subarray(HEADER_SIZE));
    for (let i = 0; i < body.length; i++) body[i] ^= key;
    return new TextDecoder("euc-kr").decode(body);
}

describe("malformed RGB tuple tolerance", () => {
    it("consumeRGB / consumeNextValue handle a missing closing paren", () => {
        // TimeEnv0.INT ships [StaticMeshAmbient] COLOR1 without the closing ')'
        expect(consumeRGB("(T=0,R=110,G=84,B=77")).toEqual([0, 110, 84, 77, 255]);
        expect(consumeRGB("(T=1,R=88,G=50,B=45)")).toEqual([1, 88, 50, 45, 255]);
    });

    it("parses the real malformed COLOR1 line in TimeEnv0.INT [StaticMeshAmbient]", () => {
        const text = decryptEucKr("c:/Games/HighFive/system/TimeEnv0.INT");
        const readOffset = findSection(text, "StaticMeshAmbient");
        const [numName, numVal] = consumeNextValue(text, readOffset);
        expect(numName.toLowerCase()).toBe("num");

        // first value after NUM (comment lines are skipped by consumeNextValue)
        const afterNum = readOffset + (text.indexOf("\r\n", readOffset) - readOffset + 2);
        const [name, val] = consumeNextValue(text, afterNum);
        expect(name.toLowerCase()).toBe("color1");
        expect(() => consumeRGB(val)).not.toThrow();
        expect(consumeRGB(val)).toEqual([0, 110, 84, 77, 255]);
        expect(parseInt(numVal)).toBeGreaterThan(0);
    });
});
