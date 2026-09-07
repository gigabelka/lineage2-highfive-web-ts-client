import { afterEach, describe, expect, it, vi } from "vitest";

/* Node (no `navigator.storage`) => fetchAssetHandle uses the uncached path,
 * which is enough to lock the path-resolution + SPA-fallback guard. */

const originalFetch = globalThis.fetch;
const originalSelf = (globalThis as any).self;

afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).self = originalSelf;
    vi.resetModules();
});

function stubEnv(response: Partial<Response> & { _body?: ArrayBuffer }) {
    (globalThis as any).self = { location: { origin: "http://127.0.0.1:8888" } };
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/octet-stream" }),
        arrayBuffer: async () => response._body ?? new ArrayBuffer(8),
        ...response
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

describe("fetchAssetHandle path resolution", () => {
    it("resolves a bare relative path against the origin root, not the caller's URL", async () => {
        const fetchMock = stubEnv({ _body: new ArrayBuffer(16) });
        const { default: fetchAssetHandle } = await import("./asset-handle");

        await fetchAssetHandle("assets/system/env.int");

        expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:8888/assets/system/env.int");
    });

    it("leaves an already-absolute /assets path at the origin root", async () => {
        const fetchMock = stubEnv({ _body: new ArrayBuffer(16) });
        const { default: fetchAssetHandle } = await import("./asset-handle");

        await fetchAssetHandle("/assets/system/env.int");

        expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:8888/assets/system/env.int");
    });

    it("rejects an HTML (SPA-fallback) response instead of caching it as an asset", async () => {
        stubEnv({ headers: new Headers({ "content-type": "text/html" }) });
        const { default: fetchAssetHandle } = await import("./asset-handle");

        await expect(fetchAssetHandle("assets/system/env.int")).rejects.toThrow(/HTML response/);
    });

    it("rejects a non-ok response", async () => {
        stubEnv({ ok: false, status: 404, statusText: "Not Found" });
        const { default: fetchAssetHandle } = await import("./asset-handle");

        await expect(fetchAssetHandle("assets/system/env.int")).rejects.toThrow(/404/);
    });
});
