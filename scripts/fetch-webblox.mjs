import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "vendor", "webblox", "engine");
const VERSION_FILE = join(OUT, "version.json");

const BINARY_TYPE = "WebClientApp";
const CLIENT_VERSION_URL = `https://clientsettings.roblox.com/v2/client-version/${BINARY_TYPE}`;
const FLAGS_URL = `https://clientsettingscdn.roblox.com/v2/settings/application/${BINARY_TYPE}`;
const CDN = "https://setup.rbxcdn.com/webclient";
const CORE = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "audio-processor-fast.js"];
const CONCURRENCY = 16;
const RETRIES = 3;
const VERSION_RE = /^version-[0-9a-f]{16}$/;
const GZIP = ["WebClient.wasm"];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function sizeOnDisk(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function download(url, path, expectedSize) {
  const existing = await sizeOnDisk(path);
  if (existing >= 0 && (expectedSize === undefined || existing === expectedSize)) return false;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const declared = res.headers.get("content-encoding") ? NaN : Number(res.headers.get("content-length"));
      const want = expectedSize ?? (Number.isFinite(declared) ? declared : undefined);
      if (want !== undefined && body.length !== want) throw new Error(`size ${body.length}, expected ${want}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.part`, body);
      await rename(`${path}.part`, path);
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

async function pool(items, worker) {
  let next = 0;
  let done = 0;
  const failures = [];
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        failures.push(err.message);
      }
      if (++done % 250 === 0 || done === items.length) console.log(`[webblox] ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return failures;
}

async function main() {
  const pinned = process.argv[2];
  if (pinned !== undefined && !VERSION_RE.test(pinned)) {
    console.error(`[webblox] "${pinned}" is not a version-<16 hex> upload id`);
    process.exit(1);
  }
  const live = pinned ? null : await getJson(CLIENT_VERSION_URL);
  const upload = pinned ?? live.clientVersionUpload;
  if (!VERSION_RE.test(upload ?? "")) throw new Error(`unexpected client-version response: ${JSON.stringify(live)}`);
  const base = `${CDN}/${upload}-RobloxWebClient`;
  console.log(`[webblox] engine ${upload}${live ? ` (${live.version})` : " (pinned)"}`);
  console.log(`[webblox] from ${base}`);

  let previous = null;
  try {
    previous = JSON.parse(await readFile(VERSION_FILE, "utf8")).clientVersionUpload;
  } catch {}
  if (previous !== upload) {
    if (previous) console.log(`[webblox] replacing ${previous}`);
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(OUT, { recursive: true });
  const record = { clientVersionUpload: upload, version: live?.version ?? null, source: base, complete: false };
  await writeFile(VERSION_FILE, `${JSON.stringify(record, null, 2)}\n`);

  for (const name of CORE) {
    const fetched = await download(`${base}/${name}`, join(OUT, name));
    console.log(`[webblox] ${fetched ? "fetched" : "kept"} ${name}`);
  }
  for (const name of GZIP) {
    const path = join(OUT, name);
    if ((await sizeOnDisk(`${path}.gz`)) >= 0) continue;
    await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(`${path}.gz.part`));
    await rename(`${path}.gz.part`, `${path}.gz`);
    console.log(`[webblox] gzipped ${name} (${((await sizeOnDisk(`${path}.gz`)) / 1e6).toFixed(1)} MB)`);
  }

  const flags = await getJson(FLAGS_URL);
  const pinnedAt = new Date().toISOString();
  await writeFile(join(OUT, "PinnedFlags.json"),
    JSON.stringify({ engine: upload, pinnedAt, applicationSettings: flags.applicationSettings }));
  console.log(`[webblox] pinned ${Object.keys(flags.applicationSettings).length} flags`);

  await writeFile(VERSION_FILE, `${JSON.stringify({ ...record, complete: true, fetchedAt: pinnedAt }, null, 2)}\n`);
  console.log(`[webblox] done: ${OUT}`);
}

main().catch(err => {
  console.error(`[webblox] ${err.message}`);
  process.exit(1);
});