// local contracts for the two-stage asset fetch (lazy OPFS handle -> readable buffer)
interface IReadyAssetHandle {
    readonly isReadable: true;
    readonly buffer: ArrayBuffer;
    getReadable(): Promise<IReadyAssetHandle>;
}

interface ILazyAssetHandle {
    readonly isReadable: boolean;
    getReadable(): Promise<IReadyAssetHandle>;
}

/* Resolve an asset path against the ORIGIN ROOT, not the current script's URL.
 * The decode worker is served from /src/assets/decode-worker/, so a bare
 * relative "assets/system/env.int" resolves there, 404s, and Vite's dev server
 * answers the 404 with index.html at HTTP 200 - which then gets written into
 * OPFS as the asset and every later decode reads HTML instead of the file.
 * Package paths already start with "/assets/" (asset-loader.createPackage);
 * this makes every other caller safe too. */
function assetUrl(path: string): string {
    return new URL(path, self.location.origin).href;
}

/* Guard against the SPA fallback: a 404 answered with index.html (200,
 * text/html) is the classic way an asset fetch "succeeds" with wrong bytes. */
function assertRealAsset(path: string, response: Response): void {
    if (!response.ok) throw new Error(`asset fetch ${path}: ${response.status} ${response.statusText}`);

    if ((response.headers.get("content-type") ?? "").includes("text/html"))
        throw new Error(`asset fetch ${path}: HTML response (SPA fallback?) - path is wrong`);
}

function looksLikeHtml(bytes: Uint8Array): boolean {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64)).trimStart().toLowerCase();

    return head.startsWith("<!doctype") || head.startsWith("<html");
}

async function fetchCached(path: string): Promise<ILazyAssetHandle> {
    const root = await navigator.storage.getDirectory();

    const parts = path.split('/').filter(Boolean);
    const baseName = parts.pop()!;

    let dir: FileSystemDirectoryHandle = root;
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
    }

    const fh = await dir.getFileHandle(baseName, { create: true });

    // multiple decode workers can race to populate the same shared package (native/core/
    // engine.u) on a cold cache - a named lock serializes the fetch+write so only one
    // context does it; the rest just wait, then see the now-populated file below
    await navigator.locks.request(`asset-cache:${path}`, async () => {
        const existingFile = await fh.getFile();

        // size 0 == cold; a small cached file may be a poisoned SPA-fallback HTML
        // page from the pre-assetUrl bug - re-validate and self-heal those
        let stale = existingFile.size === 0;

        if (!stale && existingFile.size < 4096)
            stale = looksLikeHtml(new Uint8Array(await existingFile.slice(0, 64).arrayBuffer()));

        if (stale) {
            const response = await fetch(assetUrl(path));

            assertRealAsset(path, response);

            const writable = await fh.createWritable();
            await response.body!.pipeTo(writable);
        }
    });

    return new LazyFileSystemHandle(fh, path);
}

async function uncachedFetch(path: string): Promise<IReadyAssetHandle> {
    const response = await fetch(assetUrl(path));

    assertRealAsset(path, response);

    const buffer = await response.arrayBuffer();

    return new ReadAssetHandle(buffer);
}

async function fetchAssetHandle(path: string): Promise<ILazyAssetHandle> {
    if (navigator.storage) return fetchCached(path);

    return uncachedFetch(path) as unknown as ILazyAssetHandle;
}

class ReadAssetHandle implements IReadyAssetHandle {
    public readonly isReadable = true;
    public readonly buffer: ArrayBuffer;

    public async getReadable(): Promise<this> {
        return this;
    }

    public constructor(buffer: ArrayBuffer) {
        this.buffer = buffer;
    }
}

class LazyFileSystemHandle implements ILazyAssetHandle {
    public readonly isReadable = false;

    protected readonly fh: FileSystemFileHandle;
    protected readonly path: string;

    public constructor(fh: FileSystemFileHandle, path: string) {
        this.fh = fh;
        this.path = path;
    }

    public async getReadable(): Promise<IReadyAssetHandle> {
        if ("createSyncAccessHandle" in this.fh) {
            // sync access handles are exclusive per file across the whole origin - a
            // shared package (e.g. referenced by sectors on different decode workers)
            // can get read by more than one worker at once, so this needs the same lock
            // fetchCached uses for the write, not just a same-worker guard
            return navigator.locks.request(`asset-cache:${this.path}`, async () => {
                const accessHandle = await this.fh.createSyncAccessHandle();
                const size = accessHandle.getSize();
                const buffer = new ArrayBuffer(size);
                accessHandle.read(new Uint8Array(buffer), { at: 0 });
                accessHandle.close();

                return new ReadAssetHandle(buffer);
            });
        }

        const f = await this.fh.getFile();
        const b = await f.arrayBuffer();

        return new ReadAssetHandle(b);
    }

}

export default fetchAssetHandle;
export { fetchAssetHandle };