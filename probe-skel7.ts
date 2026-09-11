/* TEMPORARY: raw byte dump from the decoded fighter.ukx package */
import fs from "node:fs";
import nodePath from "node:path";

const ROOT = "c:/Games/HighFive";
const assetList = JSON.parse(fs.readFileSync("html/asset-list.json", "utf8"));
const supported: Record<string, string> = assetList.supported;

function hexdump(u8: Uint8Array, base: number, per = 16) {
    const out: string[] = [];
    for (let i = 0; i < u8.length; i += per) {
        const row = u8.subarray(i, i + per);
        out.push(`${base + i}\t${[...row].map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
    }
    return out.join("\n");
}

async function main() {
    const UPackageMod = await import("@unreal/un-package");
    const UPackage: any = (UPackageMod as any).default;
    UPackage.prototype.readArrayBuffer = async function (this: any) {
        const rel = this.path.replace(/^\/assets\//, "");
        const buf = fs.readFileSync(nodePath.join(ROOT, supported[rel] ?? rel));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
    const AssetLoader: any = (await import("@client/assets/asset-loader")).default;
    const loader = await AssetLoader.Instantiate(supported);
    const pkg: any = await loader.using(loader.getPackage("fighter", "Animation"));

    const start = Number(process.argv[2] ?? 14791250);
    const len = Number(process.argv[3] ?? 250);
    console.log(`buffer bytes: ${pkg.buffer.byteLength}, contentOffset=${pkg.contentOffset}`);
    console.log(hexdump(new Uint8Array(pkg.buffer, start, len), start));
}
main().catch(e => { console.log("FAIL", e.message); process.exit(0); });
