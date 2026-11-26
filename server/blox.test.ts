import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createBloxHandler } from "./blox";

const root = mkdtempSync(join(tmpdir(), "blox-"));
const host = join(root, "webblox");
const engine = join(root, "engine");
mkdirSync(host);
mkdirSync(join(engine, "content"), { recursive: true });
writeFileSync(join(host, "index.html"), "<!doctype html><title>WeBlox</title>");
writeFileSync(join(host, "sw.js"), "// sw");
writeFileSync(join(root, "secret.txt"), "secret");
writeFileSync(join(root, "epoxy.mjs"), "export default 1");
writeFileSync(join(engine, "PinnedFlags.json"), JSON.stringify({ applicationSettings: { ExistingFlag: "True" } }));
const wasm = new Uint8Array(4096).fill(7);
writeFileSync(join(engine, "WebClient.wasm"), wasm);
writeFileSync(join(engine, "WebClient.wasm.gz"), gzipSync(wasm));
writeFileSync(join(engine, "content", "a.png"), "png");
const source = "https://setup.rbxcdn.com/webclient/version-0123456789abcdef-RobloxWebClient";
writeFileSync(join(engine, "version.json"), JSON.stringify({ source }));

const fetched: string[] = [];
const fakeCdn = (async (input: string | URL | Request) => {
  const url = String(input);
  fetched.push(url);
  return url.endsWith("/content/late.png") ? new Response("late") : new Response("missing", { status: 403 });
}) as typeof fetch;

const handle = createBloxHandler({ host, engine, epoxy: join(root, "epoxy.mjs") }, fakeCdn);
const get = (path: string, headers: HeadersInit = {}) => handle(new Request(`http://webblox.test${path}`, { headers }), path);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("/blox/", () => {
  test("serves the page and engine cross-origin isolated, which SharedArrayBuffer needs", async () => {
    for (const path of ["/blox/", "/blox/sw.js", "/blox/engine/content/a.png", "/blox/epoxy.mjs"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    }
    expect(await (await get("/blox/")).text()).toContain("<title>WeBlox</title>");
  });

  test("sends the gzip engine binary only to browsers that accept it", async () => {
    const gzipped = await get("/blox/engine/WebClient.wasm", { "accept-encoding": "gzip, br" });
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    expect(gzipped.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await gzipped.arrayBuffer())).not.toEqual(wasm);

    const plain = await get("/blox/engine/WebClient.wasm");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(wasm);
  });

  test("never serves files outside the host page and engine", async () => {
    for (const path of ["/blox/secret.txt", "/blox/engine/../secret.txt", "/blox/engine/%2e%2e/secret.txt", "/blox/engine/..%2fsecret.txt", "/blox/constructor"]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  test("takes an engine file missing from disk from the CDN folder it was pulled from", async () => {
    const late = await get("/blox/engine/content/late.png");
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("late");
    expect(late.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(fetched).toContain(`${source}/content/late.png`);

    expect((await get("/blox/engine/content/gone.png")).status).toBe(404);
  });

  test("pins Roblox graphics to manual quality level 1", async () => {
    const response = await get("/blox/engine/PinnedFlags.json");
    const flags = await response.json();
    expect(flags.applicationSettings).toEqual({
      ExistingFlag: "True",
      DFIntDebugFRMQualityLevelOverride: "1",
    });
  });
});
