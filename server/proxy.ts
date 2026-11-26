import { resolve } from "node:path";
import { controllerPath } from "@mercuryworkshop/scramjet-controller/path";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

export const PROXY_PREFIX = "/proxy/";
export const PROXY_LOGIN_PATH = "/logon";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const FILES: Record<string, { path: string; type: string }> = {
  "index.html": { path: resolve(import.meta.dir, "..", "proxy", "index.html"), type: MIME_TYPES[".html"]! },
  "style.css": { path: resolve(import.meta.dir, "..", "proxy", "style.css"), type: MIME_TYPES[".css"]! },
  "sw.js": { path: resolve(import.meta.dir, "..", "proxy", "sw.js"), type: MIME_TYPES[".js"]! },
  "scramjet/scramjet.js": { path: resolve(scramjetPath, "scramjet.js"), type: MIME_TYPES[".js"]! },
  "scramjet/scramjet.wasm": { path: resolve(scramjetPath, "scramjet.wasm"), type: MIME_TYPES[".wasm"]! },
  "controller/controller.api.js": { path: resolve(controllerPath, "controller.api.js"), type: MIME_TYPES[".js"]! },
  "controller/controller.inject.js": { path: resolve(controllerPath, "controller.inject.js"), type: MIME_TYPES[".js"]! },
  "controller/controller.sw.js": { path: resolve(controllerPath, "controller.sw.js"), type: MIME_TYPES[".js"]! },
};

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function createProxyHandler(mainScript: ArrayBuffer) {
  return async function handleProxy(req: Request, pathname: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    let relative: string;
    try {
      relative = pathname === PROXY_LOGIN_PATH ? "" : decodeURIComponent(pathname.slice(PROXY_PREFIX.length));
    } catch {
      return notFound();
    }
    if (!relative) relative = "index.html";
    if (relative === "main.js") {
      return new Response(req.method === "HEAD" ? null : mainScript, {
        headers: {
          "content-type": MIME_TYPES[".js"]!,
          "cache-control": "no-cache",
        },
      });
    }
    const file = FILES[relative];
    if (!file) return notFound();
    const blob = Bun.file(file.path);
    if (!(await blob.exists())) return notFound();
    return new Response(req.method === "HEAD" ? null : blob, {
      headers: {
        "content-type": file.type,
        "cache-control": "no-cache",
      },
    });
  };
}

export async function buildProxyScript(): Promise<ArrayBuffer> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "..", "proxy", "main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    write: false,
  });
  if (!result.success) {
    throw new Error(`Could not build the Scramjet UI:\n${result.logs.map((log) => log.message).join("\n")}`);
  }
  const output = result.outputs[0];
  if (!output) throw new Error("Scramjet UI build produced no JavaScript output.");
  return output.arrayBuffer();
}
