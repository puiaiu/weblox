// Host page for Roblox's own browser client (binary type WebClientApp, pulled
// into vendor/webblox/engine by scripts/fetch-webblox.mjs).
//
// 1. Answers sw.js: every cross-origin request the engine makes arrives here
//    and goes out over Wisp through epoxy, which runs TLS in this page, so the
//    Wisp server never sees the session. Cookies live in a jar in localStorage.
// 2. Takes the Roblox session (.ROBLOSECURITY) out of a Scramjet 2 browser on
//    this origin: the sign-in prompt opens roblox.com/login through it and
//    watches its cookie jar, or accepts a pasted cookie.
// 3. Boots WasmPlayer.js the way Roblox's WasmLoader.js does, pointed at the
//    engine on this server.
//
// ?placeId=<id> joins that experience (&gameInstanceId=<job id> one server of
// it); without a place the page is a launcher. With a Scramjet 2 proxy,
// roblox.com's Play button opens this page (integrations/scramjet/plugin.ts).

const ROOT = new URL("./", import.meta.url);
const ENGINE_BASE = new URL("engine", ROOT).href;
const WISP_KEY = "blox.wisp";
// ?proxy=<where this site's proxy opens a page>; {url} is replaced with the
// encoded destination, or the encoded URL is appended. Remembered like ?wisp.
const PROXY_KEY = "blox.proxy";
const LOGIN_URL = "https://www.roblox.com/login";
const JAR_KEY = "blox.cookies";
const MANUAL_KEY = "blox.manual";
const ACCOUNTS_KEY = "blox.accounts";
const LOGGED_OUT_KEY = "blox.loggedOut";
const THEME_KEY = "blox.theme";
const THEMES = new Set(["red", "blue", "pink", "purple", "green", "orange"]);
// ?placeId=…&gameInstanceId=…: join that server of the place (roblox.com's
// Join on a server or a friend). The id is a job id, a UUID in practice.
const JOIN_SERVER = (() => {
  const params = new URLSearchParams(location.search);
  const placeId = params.get("placeId");
  const serverId = params.get("gameInstanceId");
  return placeId && serverId && /^[A-Za-z0-9-]{1,64}$/.test(serverId) ? { placeId, serverId } : null;
})();
const SESSION = ".ROBLOSECURITY";
const SESSION_PREFIX = "_|WARNING:-DO-NOT-SHARE-THIS.";
const SESSION_CHECK = "https://users.roblox.com/v1/users/authenticated";
const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
// Dropped from what the engine sent: the browser's own values describe this
// page, not www.roblox.com, and epoxy sets length and host itself.
const DROP_REQUEST = new Set(["cookie", "content-length", "host", "origin", "referer", "connection"]);
// Dropped from what Roblox sent: epoxy already decoded the body, the cookies
// went into the jar, and the CORS and isolation headers are set by sw.js.
const DROP_RESPONSE = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers",
  "access-control-allow-methods", "access-control-expose-headers", "cross-origin-opener-policy",
  "cross-origin-embedder-policy", "cross-origin-resource-policy", "strict-transport-security",
]);

const status = document.getElementById("status");
const say = (text) => {
  status.textContent = text;
};

// ---- Wisp transport ---------------------------------------------------------

// Opened with ?wisp=<server> (the opener may be on another origin, so
// localStorage cannot carry it), the page remembers that server for the joins
// that follow. Otherwise it uses /wisp/ on this host, which server.ts serves.

function wispUrl() {
  const url = new URL(location.href);
  const given = url.searchParams.get("wisp");
  if (given !== null) {
    if (/^wss?:\/\//i.test(given)) localStorage.setItem(WISP_KEY, given);
    url.searchParams.delete("wisp");
    history.replaceState(history.state, "", url);
  }
  const stored = localStorage.getItem(WISP_KEY);
  if (stored && /^wss?:\/\//i.test(stored)) return stored;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

const WISP = wispUrl();

// The proxy's way of opening a page, if the site configured one.
function proxyTemplate() {
  const url = new URL(location.href);
  const given = url.searchParams.get("proxy");
  if (given !== null) {
    if (given) localStorage.setItem(PROXY_KEY, given);
    else localStorage.removeItem(PROXY_KEY);
    url.searchParams.delete("proxy");
    history.replaceState(history.state, "", url);
    return given || null;
  }
  return localStorage.getItem(PROXY_KEY) ?? "/logon";
}

function templateLoginUrl(template) {
  if (!template) return null;
  let url;
  try {
    if (template === "/logon") {
      url = new URL(template, location.href);
    } else {
      const encoded = encodeURIComponent(LOGIN_URL);
      url = new URL(template.includes("{url}") ? template.replaceAll("{url}", encoded) : template + encoded, location.href);
    }
  } catch {
    return null;
  }
  return url.origin === location.origin ? url.href : null;
}

// Opened from the proxy's own roblox.com page, this document's referrer is that
// proxied frame: /<controller>/<frame>/<encoded url>. Swapping the encoded URL
// for the login's gives a login page the proxy can serve. Only correct for a
// codec that is encodeURIComponent, which is Scramjet's default; asking the
// proxy over the sign-in channel comes first.
function referrerLoginUrl() {
  let referrer;
  try {
    referrer = new URL(document.referrer);
  } catch {
    return null;
  }
  if (referrer.origin !== location.origin) return null;
  const match = /https?(?::|%3A)/i.exec(referrer.pathname);
  if (!match || match.index < 2) return null;
  return `${referrer.origin}${referrer.pathname.slice(0, match.index)}${encodeURIComponent(LOGIN_URL)}`;
}
// Epoxy waits forever on a Wisp server that never answers; give up instead.
const REQUEST_TIMEOUT_MS = 30_000;

const transport = (async () => {
  const { default: EpoxyTransport } = await import(new URL("epoxy.mjs", ROOT).href);
  const epoxy = new EpoxyTransport({ wisp: WISP });
  await epoxy.init();
  return epoxy;
})();

// ---- Cookie jar ---------------------------------------------------------------
// { name, value, domain, hostOnly, path, expires (ms, 0 = session) }

function readJar() {
  try {
    const jar = JSON.parse(localStorage.getItem(JAR_KEY) || "[]");
    return Array.isArray(jar) ? jar.filter((c) => !c.expires || c.expires > Date.now()) : [];
  } catch {
    return [];
  }
}

function writeJar(jar) {
  localStorage.setItem(JAR_KEY, JSON.stringify(jar));
}

function domainMatches(host, cookie) {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

function pathMatches(path, cookiePath) {
  return path === cookiePath || path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function cookieHeader(url) {
  return readJar()
    .filter((c) => domainMatches(url.hostname, c) && pathMatches(url.pathname, c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function putCookie(jar, cookie) {
  const kept = jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
  if (!cookie.expires || cookie.expires > Date.now()) kept.push(cookie);
  return kept;
}

function parseSetCookie(url, line) {
  const [pair, ...attributes] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: "/",
    expires: 0,
  };
  let maxAge = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain" && value) {
      const domain = value.replace(/^\./, "").toLowerCase();
      // A host may only set cookies for itself or a parent domain.
      if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return null;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expires = time;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      maxAge = Number(value);
    }
  }
  // Max-Age wins over Expires; zero or less deletes the cookie.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 1 : Date.now() + maxAge * 1000;
  return cookie;
}

// `manual`: pasted here rather than taken from the Scramjet browser.
function storeSession(value, manual) {
  let jar = readJar().filter((c) => c.name !== SESSION);
  jar = putCookie(jar, { name: SESSION, value, domain: "roblox.com", hostOnly: false, path: "/", expires: 0 });
  writeJar(jar);
  localStorage.setItem(MANUAL_KEY, manual ? "1" : "0");
}

function forgetSession() {
  writeJar(readJar().filter((c) => c.name !== SESSION));
}

const savedSession = () => readJar().find((c) => c.name === SESSION)?.value ?? null;

function readAccounts() {
  try {
    const accounts = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
    return Array.isArray(accounts) ? accounts.filter((account) =>
      /^[1-9]\d{0,18}$/.test(String(account?.id)) &&
      typeof account.name === "string" &&
      typeof account.session === "string" &&
      account.session.startsWith(SESSION_PREFIX),
    ) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function rememberAccount(account, session = savedSession()) {
  const id = String(account?.id ?? "");
  if (!/^[1-9]\d{0,18}$/.test(id) || !session?.startsWith(SESSION_PREFIX)) return;
  const accounts = readAccounts().filter((saved) => saved.id !== id);
  accounts.unshift({
    id,
    name: String(account.name || account.displayName || `User ${id}`),
    displayName: String(account.displayName || account.name || `User ${id}`),
    avatar: typeof account.avatar === "string" ? account.avatar : null,
    session,
  });
  writeAccounts(accounts);
}

// ---- Requests -----------------------------------------------------------------

// Roblox's game servers are reached over WebTransport at *.qdmux.roblox.com.
// gamejoin only returns that name (gameFqdn) to the web client; with a native
// client's user agent it returns the UDMUX relay and a net stack token
// instead, from which the name is derived. Both rules are taken from a working
// deployment of this client, not from Roblox documentation.
function nativeUserAgent(value) {
  return value.replace(/Roblox\/Web\s+\w+\s+Desktop/, "Roblox/WinInet").replace(/\s*Browser\/\S+/, "");
}

function qdmuxFqdn(joinScript) {
  const udmux = joinScript.UdmuxEndpoints?.[0];
  const netStackToken = String(joinScript.NetStackTokenValue || "");
  if (!udmux || !netStackToken || !joinScript.MachineAddress || !joinScript.NetStackPort) return null;
  let token = netStackToken.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) {
    try {
      token = [...atob(netStackToken)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }
  if (token.length !== 32) return null;
  const relay = String(udmux.Address).split(".").map(Number);
  const machine = String(joinScript.MachineAddress).split(".").map(Number);
  const octets = (list) => list.length === 4 && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!octets(relay) || !octets(machine)) return null;
  relay[3] += 1;
  if (relay[3] > 255) return null;
  const hex = (list) => list.map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${token}-${hex(machine)}-${Number(joinScript.NetStackPort).toString(16)}.${hex(relay)}.qdmux.roblox.com`;
}

function withGameFqdn(body) {
  try {
    const json = JSON.parse(new TextDecoder().decode(body));
    if (!json?.joinScript || json.joinScript.gameFqdn) return body;
    const fqdn = qdmuxFqdn(json.joinScript);
    if (!fqdn) return body;
    json.joinScript.gameFqdn = fqdn;
    return new TextEncoder().encode(JSON.stringify(json)).buffer;
  } catch {
    return body;
  }
}

// roblox.com's Join on a server or a friend names one server (game instance).
// The engine always asks gamejoin for any server of the place; for that
// place's first join (not a teleport), ask for the named one instead.
function joinNamedServer(target, body) {
  if (!JOIN_SERVER || target.pathname !== "/v1/join-game" || !body) return body;
  try {
    const request = JSON.parse(new TextDecoder().decode(body));
    if (String(request.placeId) !== JOIN_SERVER.placeId || request.isTeleport) return body;
    target.pathname = "/v1/join-game-instance";
    return new TextEncoder().encode(JSON.stringify({ ...request, gameId: JOIN_SERVER.serverId })).buffer;
  } catch {
    return body;
  }
}

async function upstream({ url, method, headers, body }) {
  const target = new URL(url);
  const out = new Map();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (!DROP_REQUEST.has(key) && !key.startsWith("sec-")) out.set(key, value);
  }
  const roblox = ROBLOX_HOST.test(target.hostname);
  const gameJoin = roblox && target.hostname === "gamejoin.roblox.com" && method === "POST";
  out.set("origin", roblox ? "https://www.roblox.com" : target.origin);
  out.set("referer", roblox ? "https://www.roblox.com/" : `${target.origin}/`);
  if (gameJoin) {
    out.set("rbx-user-agent", "Roblox/Darwin");
    body = joinNamedServer(target, body);
  } else if (roblox && out.has("rbx-user-agent")) {
    out.set("rbx-user-agent", nativeUserAgent(out.get("rbx-user-agent")));
  }
  const cookies = cookieHeader(target);
  if (cookies) out.set("cookie", cookies);

  const epoxy = await transport;
  let timer;
  const response = await Promise.race([
    epoxy.request(target, method, body && body.byteLength ? body : null, [...out], undefined),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer from ${target.hostname} through the Wisp server ${WISP} in ${REQUEST_TIMEOUT_MS / 1000}s`)),
        REQUEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  let data = await new Response(response.body).arrayBuffer();

  let jar = null;
  const kept = [];
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      const cookie = parseSetCookie(target, value);
      if (cookie) jar = putCookie(jar ?? readJar(), cookie);
    } else if (key === "location") {
      kept.push([key, new URL(value, target).href]);
    } else if (!DROP_RESPONSE.has(key)) {
      kept.push([key, value]);
    }
  }
  if (jar) writeJar(jar);
  if (gameJoin && response.status === 200) data = withGameFqdn(data);
  return { status: response.status, statusText: response.statusText, headers: kept, body: data };
}

navigator.serviceWorker.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type !== "blox-fetch") return;
  const [port] = event.ports;
  try {
    const result = await upstream(message);
    port.postMessage({ ok: true, ...result }, [result.body]);
  } catch (error) {
    console.error("[blox] relay failed:", message.method, message.url, error);
    port.postMessage({ ok: false, error: String(error?.message || error) });
  }
});
navigator.serviceWorker.startMessages();

// ---- Session ------------------------------------------------------------------

async function sessionAccepted() {
  const result = await upstream({ url: SESSION_CHECK, method: "GET", headers: [], body: null });
  return result.status === 200;
}

// A Scramjet 2 browser on this origin (its controller) keeps its cookie jar in
// IndexedDB, so signing in to roblox.com there leaves .ROBLOSECURITY where
// this page can read it. Never creates the database when it is missing.
function proxySession() {
  return new Promise((resolve) => {
    const open = indexedDB.open("__scramjet_controller");
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      const finish = (value) => {
        db.close();
        resolve(value);
      };
      try {
        const get = db.transaction("state", "readonly").objectStore("state").get("cookies");
        get.onsuccess = () => finish(sessionFromDump(get.result?.cookies));
        get.onerror = () => finish(null);
      } catch {
        finish(null);
      }
    };
  });
}

// The controller stores CookieJar.dump(): JSON of { [key]: { name, value, domain, … } }.
function sessionFromDump(dump) {
  if (typeof dump !== "string") return null;
  let cookies;
  try {
    cookies = JSON.parse(dump);
  } catch {
    return null;
  }
  for (const cookie of Object.values(cookies ?? {})) {
    if (cookie?.name !== SESSION || typeof cookie.value !== "string" || !cookie.value) continue;
    if (/^\.?(?:[^.]+\.)*roblox\.com$/i.test(String(cookie.domain))) return cookie.value;
  }
  return null;
}

// Puts a candidate session in the jar and keeps it only if Roblox accepts it.
async function trySession(value, manual) {
  storeSession(value, manual);
  if (await sessionAccepted()) {
    localStorage.removeItem(LOGGED_OUT_KEY);
    return true;
  }
  forgetSession();
  return false;
}

// ---- Signing in ---------------------------------------------------------------

// Only the site's own Scramjet 2 controller can make a frame its service worker
// will serve, so this page cannot open a proxied roblox.com by itself. It asks
// the controller over a BroadcastChannel (same origin: the controller's cookie
// jar in IndexedDB is readable here), opens the login URL that comes back in the
// window the click made room for, and then watches the jar until Roblox has put
// a working .ROBLOSECURITY in it. integrations/scramjet/signin.ts answers.
const SIGNIN_CHANNEL = "blox-signin";
// A page with no proxy on it never answers; stop waiting for one.
const SIGNIN_ANSWER_MS = 3_000;
// Long enough for a one-time code and a CAPTCHA; Cancel ends it sooner.
const SIGNIN_WAIT_MS = 10 * 60_000;
const SIGNIN_POLL_MS = 1_000;

function popupFeatures() {
  const width = Math.min(390, screen.availWidth);
  const height = Math.min(844, screen.availHeight);
  const left = Math.round((screen.availWidth - width) / 2);
  const top = Math.round((screen.availHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

// The proxied roblox.com/login URL, as the site's Scramjet browser made it.
function proxiedLoginUrl(clearRobloxCookies = false) {
  const prepare = (url) => {
    if (!clearRobloxCookies) return url;
    const target = new URL(url);
    if (target.origin === location.origin && (target.pathname.startsWith("/proxy/") || target.pathname === "/logon")) {
      target.searchParams.set("clearRobloxCookies", "1");
    }
    return target.href;
  };
  const configured = templateLoginUrl(proxyTemplate());
  if (configured) return Promise.resolve(prepare(configured));
  return askedLoginUrl()
    .catch((error) => {
      const referrer = referrerLoginUrl();
      if (referrer) return referrer;
      throw error;
    })
    .then(prepare);
}

// Every page of the proxy on this origin (the frame plugin, installBloxSignIn)
// answers with a URL it encoded itself.
function askedLoginUrl() {
  return new Promise((resolve, reject) => {
    let channel;
    try {
      channel = new BroadcastChannel(SIGNIN_CHANNEL);
    } catch {
      reject(new Error("This browser cannot ask the site's proxy browser for a sign-in page."));
      return;
    }
    const id = crypto.randomUUID();
    const settle = (error, url) => {
      clearTimeout(timer);
      channel.close();
      if (error) reject(error);
      else resolve(url);
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            "This site's proxy browser did not answer. Sign in to roblox.com in it, then press Sign in with Roblox again, or paste your cookie.",
          ),
        ),
      SIGNIN_ANSWER_MS,
    );
    channel.onmessage = ({ data }) => {
      if (data?.id !== id) return;
      if (data.type === "blox-signin-opened" && typeof data.url === "string") settle(null, data.url);
      else if (data.type === "blox-signin-failed") settle(new Error("This site's proxy browser could not open roblox.com."));
    };
    channel.postMessage({ type: "blox-signin-request", id, origin: location.origin });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Watches the proxy's jar until Roblox accepts a session found there. Each new
// value is tried once; the same cookie is not sent again and again.
async function waitForProxySession(stopped, onAccepted) {
  let tried = null;
  const deadline = Date.now() + SIGNIN_WAIT_MS;
  while (!stopped.now && Date.now() < deadline) {
    await sleep(SIGNIN_POLL_MS);
    if (stopped.now) return false;
    const value = await proxySession();
    if (!value || value === tried) continue;
    tried = value;
    try {
      if (await trySession(value, false)) {
        onAccepted();
        return true;
      }
    } catch {
      // Roblox is unreachable right now; keep watching for another cookie.
    }
  }
  return false;
}

// ---- Username and password ----------------------------------------------------

// Roblox challenges every sign-in from a page like this: a CSRF token, then a
// proof of work (a time-lock puzzle, about a second here), and then almost
// always an Arkose CAPTCHA that only roblox.com can render. So passwords work
// where Roblox lets the sign-in through after the puzzle, and everything else
// finishes in the site's proxy browser, which the prompt offers. The password
// is only ever sent to auth.roblox.com: it is not stored, logged or reused.
const AUTH_LOGIN = "https://auth.roblox.com/v2/login";
const PROOF_OF_WORK = "https://apis.roblox.com/proof-of-work-service/v1/pow-puzzle";
const CHALLENGE_CONTINUE = "https://apis.roblox.com/challenge/v1/continue";
const CHALLENGE_HELP = {
  captcha: "Roblox wants a CAPTCHA to finish a password sign-in, and only roblox.com can show it. Use Sign in with Roblox above.",
  captchav2: "Roblox wants a CAPTCHA to finish a password sign-in, and only roblox.com can show it. Use Sign in with Roblox above.",
  twostepverification: "This account has 2-step verification. Use Sign in with Roblox above, which can take the code.",
};

function headerOf(result, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of result.headers ?? []) if (key.toLowerCase() === wanted) return value;
  return null;
}

function bodyJson(result) {
  try {
    return JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    return null;
  }
}

function toBase64(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

// The rblx-challenge-* headers Roblox puts on a request it refuses to authorize.
function challengeOf(result) {
  const id = headerOf(result, "rblx-challenge-id");
  const type = headerOf(result, "rblx-challenge-type");
  if (!id || !type) return null;
  return { id, type: type.toLowerCase(), metadata: headerOf(result, "rblx-challenge-metadata") ?? "" };
}

function loginRequest(username, password, csrf, challenge) {
  const headers = [
    ["accept", "application/json"],
    ["content-type", "application/json"],
    ["user-agent", navigator.userAgent],
  ];
  if (csrf) headers.push(["x-csrf-token", csrf]);
  if (challenge) {
    headers.push(
      ["rblx-challenge-id", challenge.id],
      ["rblx-challenge-type", challenge.type],
      ["rblx-challenge-metadata", challenge.metadata],
    );
  }
  const body = JSON.stringify({
    ctype: username.includes("@") ? "Email" : "Username",
    cvalue: username,
    password,
  });
  return upstream({ url: AUTH_LOGIN, method: "POST", headers, body: new TextEncoder().encode(body).buffer });
}

// The puzzle's big integers are read out of the JSON text: JSON.parse would
// round a 1024-bit N to a double. A^(2^T) mod N is A squared T times, and each
// yield keeps the prompt painting while it runs.
async function solvePuzzle(artifacts, report) {
  const number = (name) => new RegExp(`"${name}"\\s*:\\s*"?([0-9]+)"?`).exec(artifacts)?.[1] ?? null;
  const modulusText = number("N");
  const startText = number("A");
  const rounds = Number(number("T"));
  if (!modulusText || !startText || !(rounds > 0)) throw new Error("Roblox sent a sign-in puzzle this page cannot solve.");
  const modulus = BigInt(modulusText);
  let value = BigInt(startText) % modulus;
  for (let round = 0; round < rounds; round += 1) {
    value = (value * value) % modulus;
    if ((round & 0x3fff) === 0x3fff) {
      report(`Solving Roblox's sign-in puzzle… ${Math.round(((round + 1) / rounds) * 100)}%`);
      await sleep(0);
    }
  }
  return value.toString();
}

// Answers the proof-of-work challenge. Returns the CSRF token, the header
// metadata the retried login carries, and the challenge that follows, if any.
async function proveWork(csrf, challenge, report) {
  const metadata = JSON.parse(fromBase64(challenge.metadata) ?? "{}");
  const sessionId = metadata?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Roblox's sign-in check did not say which puzzle to solve.");
  const nextCsrf = (result) => headerOf(result, "x-csrf-token") ?? csrf;

  const puzzleAnswer = await upstream({
    url: `${PROOF_OF_WORK}?sessionID=${encodeURIComponent(sessionId)}`,
    method: "GET",
    headers: [["accept", "application/json"], ...(csrf ? [["x-csrf-token", csrf]] : [])],
    body: null,
  });
  csrf = nextCsrf(puzzleAnswer);
  const puzzle = bodyJson(puzzleAnswer);
  if (puzzleAnswer.status !== 200 || typeof puzzle?.artifacts !== "string") {
    throw new Error(`Roblox would not hand over its sign-in puzzle (HTTP ${puzzleAnswer.status}).`);
  }
  const solution = await solvePuzzle(puzzle.artifacts, report);

  report("Checking the sign-in puzzle with Roblox…");
  const body = JSON.stringify({ sessionID: sessionId, solution });
  const verified = await upstream({
    url: PROOF_OF_WORK,
    method: "POST",
    headers: [
      ["accept", "application/json"],
      ["content-type", "application/json"],
      ...(csrf ? [["x-csrf-token", csrf]] : []),
    ],
    body: new TextEncoder().encode(body).buffer,
  });
  csrf = nextCsrf(verified);
  const answer = bodyJson(verified);
  if (verified.status !== 200 || answer?.answerCorrect !== true) {
    throw new Error(answer?.message || `Roblox rejected the sign-in puzzle (HTTP ${verified.status}).`);
  }
  const redeemed = { sessionId, redemptionToken: String(answer.redemptionToken ?? "") };
  const continued = await upstream({
    url: CHALLENGE_CONTINUE,
    method: "POST",
    headers: [
      ["accept", "application/json"],
      ["content-type", "application/json"],
      ...(csrf ? [["x-csrf-token", csrf]] : []),
      ["rblx-challenge-id", challenge.id],
      ["rblx-challenge-type", challenge.type],
      ["rblx-challenge-metadata", challenge.metadata],
    ],
    body: new TextEncoder().encode(
      JSON.stringify({ challengeId: challenge.id, challengeType: challenge.type, challengeMetadata: JSON.stringify(redeemed) }),
    ).buffer,
  });
  csrf = nextCsrf(continued);
  if (continued.status !== 200) throw new Error(`Roblox stopped the sign-in check (HTTP ${continued.status}).`);
  const next = String(bodyJson(continued)?.challengeType ?? "").toLowerCase();
  return { csrf, metadata: toBase64(JSON.stringify(redeemed)), next: next && next !== "none" ? next : null };
}

function challengeHelp(type) {
  return CHALLENGE_HELP[type] ?? `Roblox wants a "${type}" check before it accepts a password. Use Sign in with Roblox above.`;
}

function loginProblem(result) {
  const message = bodyJson(result)?.errors?.[0]?.message;
  if (result.status === 401) return "Roblox says that username or password is wrong.";
  if (result.status === 423) return "Roblox locked this account. Sign in on roblox.com to unlock it.";
  if (result.status === 429) return "Roblox is limiting sign-ins from this network. Wait a minute, then try again.";
  return message ? `Roblox: ${message}` : `Roblox answered HTTP ${result.status}.`;
}

// Leaves .ROBLOSECURITY in the jar; throws what the prompt should show.
async function passwordSignIn(username, password, report) {
  report("Checking your password with Roblox…");
  let csrf = null;
  let result = await loginRequest(username, password, csrf, null);
  csrf = headerOf(result, "x-csrf-token") ?? csrf;
  // The first POST only hands out the CSRF token, and is always a 403.
  if (result.status === 403 && csrf) result = await loginRequest(username, password, csrf, null);
  let challenge = challengeOf(result);
  if (challenge?.type === "proofofwork") {
    const work = await proveWork(csrf, challenge, report);
    if (work.next) throw new Error(challengeHelp(work.next));
    report("Checking your password with Roblox…");
    result = await loginRequest(username, password, work.csrf, {
      id: challenge.id,
      type: "proofofwork",
      metadata: work.metadata,
    });
    challenge = challengeOf(result);
  }
  if (challenge) throw new Error(challengeHelp(challenge.type));
  if (result.status !== 200) throw new Error(loginProblem(result));
}

// Joining needs a signed-in account (gamejoin answers 524 "Not authorized"
// otherwise), so this runs before the engine starts and only then.
function askForSession(expired, { clearRobloxCookies = false } = {}) {
  return new Promise((resolve) => {
    const shade = document.createElement("div");
    shade.className = "session";
    shade.innerHTML = `
      <div class="session-panel">
        <form novalidate aria-labelledby="session-title">
          <h1 id="session-title"></h1>
          <p>Sign in with your Roblox username and password, or in this site's proxy browser. Either way the session ends up here, so there is no cookie to copy.</p>
          <p>Roblox asks some sign-ins for a CAPTCHA or a two-step code; only the proxy browser can show those.</p>
          <div class="field">
            <input name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="Username or email" aria-label="Username or email" aria-describedby="session-error">
            <input name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" aria-describedby="session-error">
          </div>
          <details>
            <summary>Or paste a <code>.ROBLOSECURITY</code> cookie</summary>
            <p>It stays in this browser and is sent only to Roblox, encrypted end to end.</p>
            <input name="cookie" type="password" autocomplete="off" spellcheck="false" aria-label=".ROBLOSECURITY">
            <p class="start"><button type="button" class="cookie"><i class="fa-solid fa-cookie-bite" aria-hidden="true"></i>Use cookie</button></p>
          </details>
          <p class="working" role="status"></p>
          <p class="error" id="session-error" role="alert"></p>
          <div class="actions">
            <button type="button" class="secondary"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Back</button>
            <button type="submit"><i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i>Sign in</button>
          </div>
        </form>
        <section class="waiting" aria-labelledby="waiting-title" hidden>
          <h1 id="waiting-title">Signing in to Roblox</h1>
          <p class="waiting-text" role="status">Waiting for Roblox…</p>
          <div class="actions">
            <button type="button" class="secondary" data-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i>Cancel</button>
          </div>
        </section>
        <div class="proxy-option">
          <p style="margin-bottom: 10px;">Don't feel safe with this login?</p>
          <p class="start"><button type="button" class="proxy"><i class="fa-brands fa-roblox" aria-hidden="true"></i>Sign in with Roblox's Website</button></p>
        </div>
      </div>`;
    const form = shade.querySelector("form");
    const waiting = shade.querySelector(".waiting");
    const username = form.querySelector("[name=username]");
    const password = form.querySelector("[name=password]");
    const cookie = form.querySelector("[name=cookie]");
    const error = form.querySelector(".error");
    const working = form.querySelector(".working");
    const start = shade.querySelector(".proxy");
    const useCookie = form.querySelector(".cookie");
    const [back, submit] = form.querySelectorAll(".actions button");
    const cancel = waiting.querySelector("[data-cancel]");
    const waitingText = waiting.querySelector(".waiting-text");
    form.querySelector("h1").textContent = expired ? "Your Roblox session expired" : "Sign in to Roblox";
    const fail = (text, field = username) => {
      error.textContent = text;
      field.setAttribute("aria-invalid", "true");
      field.focus();
    };
    const showForm = () => {
      waiting.hidden = true;
      form.hidden = false;
      start.disabled = false;
    };
    for (const field of [username, password, cookie]) {
      field.addEventListener("input", () => {
        error.textContent = "";
        field.removeAttribute("aria-invalid");
      });
    }
    back.addEventListener("click", () => location.assign(ROOT.href));
    start.addEventListener("click", async () => {
      error.textContent = "";
      start.disabled = true;
      // Opened from the click, before any await: a pop-up opened later is blocked.
      const popup = window.open("about:blank", "_blank", popupFeatures());
      if (!popup) {
        start.disabled = false;
        return fail(
          "Your browser blocked the pop-up. Click the blocked pop-up icon in the address bar and allow pop-ups for this site, then press Sign in with Roblox again. You can also allow pop-ups for this site in your browser's site settings.",
        );
      }
      try {
        // Never a blank flash while the proxy is asked for its login page.
        popup.document.title = "Roblox";
        popup.document.body.style.cssText = "font:16px system-ui,sans-serif;padding:24px;color:#14151a";
        popup.document.body.textContent = "Opening Roblox…";
      } catch {
        // A browser that will not let this page paint the blank window.
      }
      // The site's proxy answers with its own roblox.com/login URL: the plugin
      // running in a proxied roblox.com page, or installBloxSignIn on the page
      // that owns the controller. Without one, the jar is still watched below.
      let opened = false;
      try {
        const url = await proxiedLoginUrl(clearRobloxCookies);
        popup.location.replace(url);
        opened = true;
      } catch (err) {
        console.warn("[blox] sign-in window:", err?.message || err);
        try {
          popup.close();
        } catch {
          // Already gone.
        }
      }
      form.hidden = true;
      waiting.hidden = false;
      waitingText.textContent = opened
        ? 'Finish signing in in the window that opened (choose "Email me a One Time Code"). This page takes the session over as soon as Roblox sets it.'
        :         "Couldn't find this site's proxy sign-in page. Sign in to roblox.com in this site's proxy browser; this page takes the session over as soon as Roblox sets it. (Site owners: open /blox/?proxy=<your proxy URL with {url}> to point this button at it.)";
      cancel.focus();
      const stopped = { now: false };
      cancel.addEventListener("click", () => {
        stopped.now = true;
      });
      let accepted = false;
      try {
        accepted = await waitForProxySession(stopped, () => {
          try {
            popup.close();
          } catch {
            // The login page's origin policies may have already cut this reference.
          }
        });
      } catch (err) {
        showForm();
        return fail(`Couldn't reach Roblox: ${err.message || err}`);
      }
      if (stopped.now) return showForm();
      if (!accepted) {
        showForm();
        return fail("No session arrived from the proxy browser. Finish signing in there, then press the button again, or paste your cookie.");
      }
      shade.remove();
      resolve();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = username.value.trim();
      const secret = password.value;
      if (!name) return fail("Enter your Roblox username or email.", username);
      if (!secret) return fail("Enter your Roblox password.", password);
      error.textContent = "";
      submit.disabled = true;
      start.disabled = true;
      useCookie.disabled = true;
      try {
        await passwordSignIn(name, secret, (text) => {
          working.textContent = text;
        });
        const value = savedSession();
        if (!value) throw new Error("Roblox accepted the password but sent no session.");
        if (!(await trySession(value, true))) throw new Error("Roblox accepted the password but that session did not work.");
      } catch (err) {
        working.textContent = "";
        submit.disabled = false;
        start.disabled = false;
        useCookie.disabled = false;
        password.value = "";
        return fail(err?.message || String(err));
      }
      shade.remove();
      resolve();
    });
    useCookie.addEventListener("click", async () => {
      const pasted = cookie.value.trim().replace(/^\.ROBLOSECURITY=/, "");
      if (pasted && !pasted.startsWith(SESSION_PREFIX)) return fail("That isn't a .ROBLOSECURITY value.", cookie);
      const value = pasted || (await proxySession());
      if (!value) return fail("No Roblox sign-in found in this site's proxy browser. Paste your .ROBLOSECURITY instead.", cookie);
      useCookie.disabled = true;
      let accepted = false;
      try {
        accepted = await trySession(value, Boolean(pasted));
      } catch (err) {
        forgetSession();
        useCookie.disabled = false;
        return fail(`Couldn't reach Roblox: ${err.message || err}`, cookie);
      }
      useCookie.disabled = false;
      if (!accepted) return fail(pasted ? "Roblox rejected that session." : "The sign-in in this site's proxy browser has expired. Sign in there again.", cookie);
      shade.remove();
      resolve();
    });
    document.body.append(shade);
    username.focus();
  });
}

// Signing in on roblox.com in the Scramjet browser is the usual way in, so that
// session wins (an account switched there follows here), unless one was
// pasted here on purpose. The other is the fallback.
async function ensureSession() {
  if (localStorage.getItem(LOGGED_OUT_KEY) === "1") return askForSession(false);
  const saved = savedSession();
  const manual = localStorage.getItem(MANUAL_KEY) === "1";
  const proxied = await proxySession();
  const order = manual ? [saved, proxied] : [proxied, saved];
  for (const value of new Set(order.filter(Boolean))) {
    if (await trySession(value, value === saved && manual)) return;
  }
  return askForSession(saved !== null);
}

// ---- Launcher -----------------------------------------------------------------

const GAME_LINK = /roblox\.com\/(?:[a-z]{2}\/)?games\/([1-9]\d{0,18})/i;

function placeFromInput(text) {
  const value = text.trim();
  if (/^[1-9]\d{0,18}$/.test(value)) return value;
  return GAME_LINK.exec(value)?.[1] ?? null;
}

async function robloxJson(url, { method = "GET", body = null } = {}) {
  let headers = [["accept", "application/json"]];
  const encoded = body === null ? null : new TextEncoder().encode(JSON.stringify(body)).buffer;
  if (encoded) headers.push(["content-type", "application/json"]);
  let result = await upstream({ url, method, headers, body: encoded });
  const csrf = headerOf(result, "x-csrf-token");
  if (method === "POST" && result.status === 403 && csrf) {
    headers = [...headers, ["x-csrf-token", csrf]];
    result = await upstream({ url, method, headers, body: encoded });
  }
  // Roblox limits requests per IP, and the IP it sees is the Wisp server's.
  if (result.status === 429) throw new Error(`Roblox is rate-limiting the Wisp server (${WISP}). Try again in a minute, or open this page with ?wisp=<another server>.`);
  const responseText = new TextDecoder().decode(result.body);
  if (result.status !== 200) {
    let detail = responseText.trim();
    try {
      const payload = JSON.parse(responseText);
      if (Array.isArray(payload.errors)) {
        detail = payload.errors.map((item) => item.message).filter(Boolean).join("; ");
      }
    } catch {
      // Include a plain-text response below when Roblox does not return JSON.
    }
    const endpoint = new URL(url);
    const route = endpoint.pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
    throw new Error(
      `Roblox answered HTTP ${result.status} at ${endpoint.hostname}${route}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  return JSON.parse(responseText);
}

async function robuxBalance() {
  const currency = await robloxJson("https://economy.roblox.com/v1/user/currency");
  if (typeof currency?.robux !== "number" || !Number.isFinite(currency.robux) || currency.robux < 0) {
    throw new Error("Roblox returned an invalid Robux balance.");
  }
  return currency.robux;
}

// Roblox's own home feed, and the games this browser has played before.
const CONTINUE_KEY = "blox.recent";
const CONTINUE_LIMIT = 10;
const FAVORITES_KEY = "blox.favorites";
const SEARCH_HISTORY_KEY = "blox.searches";
const SEARCH_HISTORY_LIMIT = 8;
const SERVER_SORT_KEY = "blox.serverSort";
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function playing(players) {
  return Number.isFinite(players) && players > 0 ? `${COMPACT.format(players)} playing` : "";
}

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(CONTINUE_KEY) || "[]");
    return Array.isArray(list) ? list.filter((game) => /^[1-9]\d{0,18}$/.test(String(game?.placeId))) : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem(CONTINUE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: recent games are a convenience.
  }
}

function readFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(list) ? list.filter((game) => /^[1-9]\d{0,18}$/.test(String(game?.placeId))) : [];
  } catch {
    return [];
  }
}

function writeFavorites(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

function readSearchHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
    return Array.isArray(history) ? history.filter((query) => typeof query === "string").slice(0, SEARCH_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const normalized = query.trim();
  if (!normalized) return;
  try {
    localStorage.setItem(
      SEARCH_HISTORY_KEY,
      JSON.stringify([normalized, ...readSearchHistory().filter((old) => old.toLowerCase() !== normalized.toLowerCase())].slice(0, SEARCH_HISTORY_LIMIT)),
    );
  } catch {
    // Search history is a convenience and does not block searching.
  }
}

function clearSearchHistory() {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    // Search history is a convenience and does not block searching.
  }
}

function readServerSort() {
  try {
    return localStorage.getItem(SERVER_SORT_KEY) === "Desc" ? "Desc" : "Asc";
  } catch {
    return "Asc";
  }
}

// What Continue is built from: the games played here, newest first.
function rememberGame(game) {
  const entry = {
    placeId: String(game.placeId),
    universeId: game.universeId ? String(game.universeId) : null,
    name: game.name ?? null,
    creator: game.creator ?? null,
    thumb: game.thumb ?? null,
    playedAt: Date.now(),
  };
  writeRecent([entry, ...readRecent().filter((old) => old.placeId !== entry.placeId)].slice(0, CONTINUE_LIMIT));
}

// 16:9 card art for a batch of universes, keyed by universe id.
async function gameThumbs(universeIds) {
  const map = new Map();
  if (!universeIds.length) return map;
  const batches = Array.from({ length: Math.ceil(universeIds.length / 100) }, (_, index) =>
    universeIds.slice(index * 100, (index + 1) * 100),
  );
  const results = await Promise.all(batches.map((batch) =>
    robloxJson(
      `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${batch.join(",")}&size=768x432&format=Webp&countPerUniverse=1`,
    ).catch(() => ({ data: [] })),
  ));
  for (const entry of results.flatMap((result) => result.data ?? [])) {
    const image = entry.thumbnails?.find((thumb) => thumb.state === "Completed" && thumb.imageUrl);
    if (image) map.set(String(entry.universeId), image.imageUrl);
  }
  return map;
}

// A place pasted as a link arrives with no name or art; fill those in once and
// keep them, so its Continue card is a real card next time.
async function localContinueGames() {
  const list = readRecent();
  if (!list.length) return [];
  const patched = await Promise.all(
    list.map(async (game) => {
      let universeId = game.universeId ?? null;
      if (!universeId) {
        try {
          const found = await robloxJson(`https://apis.roblox.com/universes/v1/places/${game.placeId}/universe`);
          universeId = found?.universeId ? String(found.universeId) : null;
        } catch {
          // Removed or private place: the card stays without art.
        }
      }
      let { name, creator } = game;
      if (universeId && (!name || !creator)) {
        try {
          // games.roblox.com/v1/games answers placeholders to a signed-out call.
          const detail = await robloxJson(`https://develop.roblox.com/v1/universes/${universeId}`);
          name = name ?? detail?.name ?? null;
          creator = creator ?? detail?.creatorName ?? null;
        } catch {
          // Keep whatever name the card had.
        }
      }
      return { ...game, universeId, name, creator };
    }),
  );
  const missing = patched.filter((game) => !game.thumb && game.universeId);
  if (missing.length) {
    const thumbs = await gameThumbs([...new Set(missing.map((game) => game.universeId))]);
    for (const game of missing) game.thumb = thumbs.get(game.universeId) ?? null;
  }
  writeRecent(patched);
  return patched;
}

// The home-page feed provides the same ordered sections as Roblox Home.
async function homeRows() {
  const response = await robloxJson("https://apis.roblox.com/discovery-api/v2/home-page", {
    method: "POST",
    // The discovery API expects a request ID here; it is not an account token.
    body: { sessionId: crypto.randomUUID() },
  });
  const page = response.pageEntries?.find((entry) => entry.pageEntry?.identifier === "home_page_feed");
  const feed = page?.inputData?.verticalFeed;
  if (!feed?.entryMap || typeof feed.entryMap !== "object") {
    throw new Error("Roblox returned an unexpected home feed.");
  }
  const entryMap = feed?.entryMap ?? {};
  const contentPools = feed?.contentPools ?? {};
  const entryOrder = Array.isArray(feed?.entryOrder) ? feed.entryOrder : Object.keys(entryMap);
  const continueItems = [];
  const rows = [];
  const seenPools = new Set();
  const allItems = [];

  for (const key of entryOrder) {
    const carousel = entryMap[key]?.inputData?.experienceCarousel;
    if (!carousel) continue;

    let items = Array.isArray(carousel.universeItems) ? carousel.universeItems : [];
    if (carousel.poolId && !items.length) {
      if (seenPools.has(carousel.poolId)) continue;
      seenPools.add(carousel.poolId);
      items = (contentPools[carousel.poolId]?.items ?? []).map((item) => item.universe ?? item);
    }

    const uniqueItems = [...new Map(
      items
        .filter((item) => /^[1-9]\d{0,18}$/.test(String(item?.universeId)))
        .map((item) => [String(item.universeId), item]),
    ).values()].slice(0, 24);
    if (!uniqueItems.length) continue;
    allItems.push(...uniqueItems);

    const row = {
      title: carousel.title || "Discover",
      items: uniqueItems,
    };
    if (/continue|recently played/i.test(row.title)) continueItems.push(...uniqueItems);
    else rows.push(row);
  }

  const universeIds = [...new Set(allItems.map((item) => String(item.universeId)))];
  const gameData = await Promise.all(
    Array.from({ length: Math.ceil(universeIds.length / 50) }, (_, index) =>
      robloxJson(`https://games.roblox.com/v1/games?universeIds=${universeIds.slice(index * 50, (index + 1) * 50).join(",")}`),
    ),
  );
  const gamesByUniverse = new Map(
    gameData.flatMap((result) => result.data ?? []).map((game) => [String(game.id ?? game.universeId), game]),
  );
  const thumbs = await gameThumbs(universeIds);
  const toGame = (item) => {
    const universeId = String(item.universeId);
    const details = gamesByUniverse.get(universeId);
    if (!details?.rootPlaceId || !/^[1-9]\d{0,18}$/.test(String(details.rootPlaceId))) return null;
    return {
      placeId: String(details.rootPlaceId),
      universeId,
      name: item.title || details.name || `Experience ${details.rootPlaceId}`,
      creator: details.creator?.name || null,
      players: details.playing,
      thumb: thumbs.get(universeId) ?? null,
      badge: item.badgeText || null,
    };
  };
  const buildGames = (items) => items.map(toGame).filter(Boolean);

  return {
    continueList: buildGames(continueItems),
    rows: rows
      .filter((row) => !/^favorites$/i.test(row.title))
      .map((row) => ({ title: row.title, games: buildGames(row.items) }))
      .filter((row) => row.games.length),
  };
}

async function publicTrendingRow() {
  const params = new URLSearchParams({ sessionId: crypto.randomUUID() });
  const response = await robloxJson(`https://apis.roblox.com/explore-api/v1/get-sorts?${params}`);
  const sort = response.sorts?.find((entry) => entry.sortId === "top-trending");
  const games = (sort?.games ?? [])
    .filter((game) => game?.universeId && game?.rootPlaceId)
    .slice(0, 24);
  if (!games.length) throw new Error("Roblox did not return any trending experiences.");
  const thumbs = await gameThumbs([...new Set(games.map((game) => String(game.universeId)))]);
  return {
    title: sort.sortDisplayName || "Top Trending",
    games: games.map((game) => ({
      placeId: String(game.rootPlaceId),
      universeId: String(game.universeId),
      name: game.name || `Experience ${game.rootPlaceId}`,
      creator: game.creatorName || null,
      players: game.playerCount,
      thumb: thumbs.get(String(game.universeId)) ?? null,
    })),
  };
}

async function searchGames(query, limit = 30) {
  const params = new URLSearchParams({
    searchQuery: query,
    pageToken: "",
    sessionId: crypto.randomUUID(),
    pageType: "all",
  });
  const search = await robloxJson(`https://apis.roblox.com/search-api/omni-search?${params}`);
  const games = (search.searchResults ?? [])
    .filter((group) => group.contentGroupType === "Game")
    .flatMap((group) => group.contents ?? [])
    .filter((game) => game.rootPlaceId && game.universeId)
    .slice(0, limit);
  if (!games.length) return [];
  const thumbs = await gameThumbs([...new Set(games.map((game) => String(game.universeId)))]);
  return games.map((game) => ({
    placeId: String(game.rootPlaceId),
    universeId: String(game.universeId),
    name: game.name,
    creator: game.creatorName,
    players: game.playerCount,
    thumb: thumbs.get(String(game.universeId)) ?? null,
  }));
}

let authenticatedAccountRequest = null;

async function authenticatedUser() {
  if (!authenticatedAccountRequest) {
    authenticatedAccountRequest = robloxJson("https://users.roblox.com/v1/users/authenticated").then((account) => {
      if (!Number.isSafeInteger(Number(account.id)) || Number(account.id) <= 0) {
        throw new Error("Roblox did not return the signed-in user's ID.");
      }
      return account;
    }).catch((error) => {
      authenticatedAccountRequest = null;
      throw error;
    });
  }
  return authenticatedAccountRequest;
}

async function authenticatedUserId() {
  const account = await authenticatedUser();
  if (!Number.isSafeInteger(Number(account.id)) || Number(account.id) <= 0) {
    throw new Error("Roblox did not return the signed-in user's ID.");
  }
  return Number(account.id);
}

let authenticatedProfileRequest = null;

async function authenticatedProfile() {
  if (!authenticatedProfileRequest) {
    authenticatedProfileRequest = (async () => {
      const account = await authenticatedUser();
      const userId = Number(account.id);
      const [avatarResult, friendCountResult] = await Promise.all([
        robloxJson(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
        ),
        robloxJson(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
      ]);
      return {
        ...account,
        avatar: avatarResult.data?.[0]?.imageUrl ?? null,
        friendsCount: Number.isFinite(Number(friendCountResult.count)) ? Number(friendCountResult.count) : null,
      };
    })().catch((error) => {
      authenticatedProfileRequest = null;
      throw error;
    });
  }
  return authenticatedProfileRequest;
}

async function userProfileData(userId) {
  const user = await robloxJson(`https://users.roblox.com/v1/users/${userId}`);
  const [avatar, avatarThumbnail, gamesResult, groups, friends, followers, following] = await Promise.allSettled([
    robloxJson(`https://avatar.roblox.com/v4/avatar/users/${userId}?selectionTypes=1&selectionTypes=3`),
    robloxJson(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`,
    ),
    robloxJson(
      `https://games.roblox.com/v2/users/${userId}/games?accessFilter=Public&limit=50&sortOrder=Asc&cursor=`,
    ),
    robloxJson(
      `https://groups.roblox.com/v1/users/${userId}/groups/roles?includeLocked=true&includeNotificationPreferences=false&discoveryType=0`,
    ),
    robloxJson(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
    robloxJson(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
    robloxJson(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
  ]);
  const publicGames = gamesResult.status === "fulfilled" ? gamesResult.value.data ?? [] : [];
  const games = publicGames.filter((game) =>
    /^[1-9]\d{0,18}$/.test(String(game.id)) &&
    /^[1-9]\d{0,18}$/.test(String(game.rootPlace?.id)),
  );
  const thumbs = await gameThumbs([...new Set(games.map((game) => String(game.id)))]);
  return {
    user,
    avatar: avatar.status === "fulfilled" ? avatar.value.avatarModel ?? null : null,
    avatarConfigurations: avatar.status === "fulfilled" ? avatar.value.avatarConfigurations ?? null : null,
    avatarThumbnail: avatarThumbnail.status === "fulfilled"
      ? avatarThumbnail.value.data?.[0]?.imageUrl ?? null
      : null,
    avatarError: avatar.status === "rejected" ? avatar.reason : null,
    games: games.map((game) => ({
      placeId: String(game.rootPlace.id),
      universeId: String(game.id),
      name: game.name || `Experience ${game.rootPlace.id}`,
      creator: user.name,
      players: null,
      thumb: thumbs.get(String(game.id)) ?? null,
      description: game.description || "",
      visits: game.placeVisits,
      updated: game.updated,
    })),
    gamesError: gamesResult.status === "rejected" ? gamesResult.reason : null,
    groups: groups.status === "fulfilled" ? groups.value.data ?? [] : [],
    groupsError: groups.status === "rejected" ? groups.reason : null,
    counts: { friends, followers, following },
  };
}

async function groupPageData(groupId) {
  const [group, roles, members] = await Promise.allSettled([
    robloxJson(`https://groups.roblox.com/v1/groups/${groupId}`),
    robloxJson(`https://groups.roblox.com/v1/groups/${groupId}/roles`),
    groupMembersPage(groupId),
  ]);
  if (group.status === "rejected") throw group.reason;
  return {
    group: group.value,
    roles: roles.status === "fulfilled" ? roles.value.roles ?? [] : [],
    rolesError: roles.status === "rejected" ? roles.reason : null,
    members: members.status === "fulfilled" ? members.value.data ?? [] : [],
    memberCursor: members.status === "fulfilled" ? members.value.nextPageCursor ?? null : null,
    membersError: members.status === "rejected" ? members.reason : null,
  };
}

function groupMembersPage(groupId, cursor = "") {
  const params = new URLSearchParams({ limit: "25", sortOrder: "Asc" });
  if (cursor) params.set("cursor", cursor);
  return robloxJson(`https://groups.roblox.com/v1/groups/${groupId}/users?${params}`);
}

async function robloxFavoriteGames() {
  const userId = await authenticatedUserId();
  const params = new URLSearchParams({ accessFilter: "2", limit: "100", sortOrder: "Desc" });
  const favorites = await robloxJson(
    `https://games.roblox.com/v2/users/${userId}/favorite/games?${params}`,
  );
  const entries = (favorites.data ?? []).filter((game) =>
    /^[1-9]\d{0,18}$/.test(String(game.id)) &&
    /^[1-9]\d{0,18}$/.test(String(game.rootPlace?.id)),
  );
  if (!entries.length) return [];
  const universeIds = [...new Set(entries.map((game) => String(game.id)))];
  const thumbs = await gameThumbs(universeIds);
  return entries.map((game) => ({
    placeId: String(game.rootPlace.id),
    universeId: String(game.id),
    name: game.name || `Experience ${game.rootPlace.id}`,
    creator: game.creator?.name || null,
    description: game.description || "",
    thumb: thumbs.get(String(game.id)) ?? null,
  }));
}

async function friendData() {
  const userId = await authenticatedUserId();
  const friends = await robloxJson(
    `https://friends.roblox.com/v1/users/${userId}/friends?limit=100&sortOrder=Asc`,
  );
  const entries = friends.data ?? [];
  if (!entries.length) return [];
  const ids = entries.map((friend) => Number(friend.id)).filter(Number.isSafeInteger);
  const missingIdentityIds = entries
    .filter((friend) => !friend.name || !friend.displayName)
    .map((friend) => Number(friend.id))
    .filter(Number.isSafeInteger);
  const [presenceResponses, thumbnails] = await Promise.all([
    Promise.all(
      Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
        robloxJson("https://presence.roblox.com/v1/presence/users", {
          method: "POST",
          body: { userIds: ids.slice(index * 50, (index + 1) * 50) },
        }),
      ),
    ),
    robloxJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(",")}&size=150x150&format=Png&isCircular=false`,
    ),
  ]);
  const identities = missingIdentityIds.length
    ? await robloxJson("https://users.roblox.com/v1/users", {
      method: "POST",
      body: { userIds: missingIdentityIds },
    })
    : { data: [] };
  const presences = new Map(
    presenceResponses.flatMap((response) => response.userPresences ?? []).map((item) => [String(item.userId), item]),
  );
  const avatars = new Map((thumbnails.data ?? []).map((item) => [String(item.targetId), item.imageUrl]));
  const names = new Map((identities.data ?? []).map((user) => [String(user.id), user]));
  return entries.map((friend) => ({
    ...friend,
    name: friend.name || names.get(String(friend.id))?.name,
    displayName: friend.displayName || names.get(String(friend.id))?.displayName,
    presence: presences.get(String(friend.id)) ?? null,
    avatar: avatars.get(String(friend.id)) ?? null,
  })).sort((left, right) => friendPresenceRank(right) - friendPresenceRank(left));
}

function friendPresenceRank(friend) {
  const presenceType = Number(friend.presence?.userPresenceType);
  if (presenceType === 2) return 2;
  if (presenceType === 1 || friend.isOnline === true) return 1;
  return 0;
}

function isFriendOnline(friend) {
  const presenceType = Number(friend.presence?.userPresenceType);
  return presenceType === 1 || presenceType === 2 || friend.isOnline === true;
}

function friendJoinTarget(friend) {
  const presence = friend.presence;
  const placeId = String(presence?.placeId || presence?.rootPlaceId || "");
  const serverId = String(presence?.gameId || "");
  return /^[1-9]\d{0,18}$/.test(placeId) && /^[A-Za-z0-9-]{1,64}$/.test(serverId)
    ? { placeId, serverId }
    : null;
}

function friendPresenceLabel(friend) {
  const presenceType = Number(friend.presence?.userPresenceType);
  if (presenceType === 2) return `Playing ${friend.presence.lastLocation || "an experience"}`;
  if (presenceType === 1 || friend.isOnline === true) return "Online";
  return "Offline";
}

function friendPresenceClass(friend) {
  const presenceType = Number(friend.presence?.userPresenceType);
  if (presenceType === 2) return "presence-in-game";
  if (presenceType === 1 || friend.isOnline === true) return "presence-online";
  return "presence-offline";
}

function onlineFriendsSection(friends, { onSeeAll, onProfile, onJoin }) {
  const online = friends.filter(isFriendOnline);
  const section = document.createElement("section");
  section.className = "online-friends";
  const header = document.createElement("div");
  header.className = "online-friends-header";
  const heading = document.createElement("h2");
  heading.append(faIcon("user-group"), document.createTextNode(`Friends (${online.length})`));
  const seeAll = document.createElement("button");
  seeAll.type = "button";
  seeAll.className = "see-all-friends";
  setIconLabel(seeAll, "arrow-right", "See all");
  seeAll.addEventListener("click", onSeeAll);
  header.append(heading, seeAll);
  section.append(header);

  if (!online.length) {
    const empty = document.createElement("p");
    empty.className = "online-friends-empty";
    empty.textContent = "No friends online right now.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "online-friend-list";
  for (const friend of online) {
    const userId = String(friend.id);
    if (!/^[1-9]\d{0,18}$/.test(userId)) continue;
    const target = friendJoinTarget(friend);
    const item = document.createElement("li");
    item.className = "online-friend-item";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "online-friend";
    const inGame = Number(friend.presence?.userPresenceType) === 2;
    if (inGame) {
      card.classList.add("is-playing");
    }
    card.addEventListener("click", () => onProfile(friend));
    card.setAttribute("aria-label", `View ${friend.displayName || friend.name || `User ${userId}`}`);
    const avatarWrap = document.createElement("span");
    avatarWrap.className = "online-friend-avatar";
    const avatar = document.createElement("img");
    avatar.alt = "";
    avatar.loading = "lazy";
    if (friend.avatar) avatar.src = friend.avatar;
    avatarWrap.append(avatar);
    const name = document.createElement("strong");
    name.textContent = friend.displayName || friend.name || `User ${userId}`;
    const activity = document.createElement("span");
    activity.className = "online-friend-activity";
    activity.classList.add(friendPresenceClass(friend));
    activity.textContent = friendPresenceLabel(friend);
    card.append(avatarWrap, name, activity);
    item.append(card);
    if (target) {
      const join = document.createElement("button");
      join.type = "button";
      join.className = "online-friend-join";
      setIconLabel(join, "gamepad", "Join");
      join.setAttribute("aria-label", `Join ${friend.displayName || friend.name || `User ${userId}`}`);
      join.addEventListener("click", () => onJoin(friend, target));
      item.append(join);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function accountHeader(profile, onProfile, onFriends) {
  const section = document.createElement("section");
  section.className = "account-header";
  const cover = document.createElement("div");
  cover.className = "account-cover";
  const title = document.createElement("h1");
  title.textContent = `Welcome back, ${profile.displayName || profile.name || "player"}`;
  cover.append(title);
  const content = document.createElement("div");
  content.className = "account-header-content";
  const avatar = document.createElement("img");
  avatar.className = "account-avatar";
  avatar.alt = "";
  if (profile.avatar) avatar.src = profile.avatar;
  const identity = document.createElement("div");
  identity.className = "account-identity";
  const displayName = document.createElement("strong");
  displayName.textContent = profile.displayName || profile.name || `User ${profile.id}`;
  const username = document.createElement("span");
  username.textContent = profile.name ? `@${profile.name}` : `User ID: ${profile.id}`;
  identity.append(displayName, username);
  const actions = document.createElement("div");
  actions.className = "account-header-actions";
  const profileButton = document.createElement("button");
  profileButton.type = "button";
  setIconLabel(profileButton, "user", "View profile");
  profileButton.addEventListener("click", () => onProfile({
    ...profile,
    presence: null,
  }));
  const friendsButton = document.createElement("button");
  friendsButton.type = "button";
  setIconLabel(friendsButton, "user-group", "Friends");
  friendsButton.addEventListener("click", onFriends);
  actions.append(profileButton, friendsButton);
  const friendCount = document.createElement("p");
  friendCount.className = "account-friend-count";
  friendCount.textContent = profile.friendsCount === null ? "Friends" : `${COMPACT.format(profile.friendsCount)} friends`;
  content.append(avatar, identity, friendCount, actions);
  section.append(cover, content);
  return section;
}

async function publicServers(placeId, cursor = "", sortOrder = "Asc") {
  const params = new URLSearchParams({ sortOrder, limit: "100" });
  if (cursor) params.set("cursor", cursor);
  return robloxJson(`https://games.roblox.com/v1/games/${placeId}/servers/Public?${params}`);
}

const experienceDetails = new Map();

async function experienceDetail(game) {
  let universeId = game.universeId ? String(game.universeId) : null;
  if (!universeId) {
    const found = await robloxJson(`https://apis.roblox.com/universes/v1/places/${game.placeId}/universe`);
    universeId = found?.universeId ? String(found.universeId) : null;
  }
  if (!universeId) throw new Error("Roblox did not return this experience's universe ID.");
  if (!experienceDetails.has(universeId)) {
    const request = robloxJson(`https://develop.roblox.com/v1/universes/${universeId}`).catch((error) => {
      experienceDetails.delete(universeId);
      throw error;
    });
    experienceDetails.set(universeId, request);
  }
  return experienceDetails.get(universeId);
}

async function universeIdForGame(game) {
  const knownId = String(game.universeId || "");
  if (/^[1-9]\d{0,18}$/.test(knownId)) return knownId;
  const result = await robloxJson(`https://apis.roblox.com/universes/v1/places/${game.placeId}/universe`);
  const universeId = String(result?.universeId || "");
  if (!/^[1-9]\d{0,18}$/.test(universeId)) {
    throw new Error("Roblox did not return this experience's universe ID.");
  }
  return universeId;
}

async function gameBadges(universeId) {
  const params = new URLSearchParams({ limit: "10", sortOrder: "Asc" });
  const result = await robloxJson(
    `https://badges.roblox.com/v1/universes/${universeId}/badges?${params}`,
  );
  const badges = (result.data ?? []).filter((badge) => /^[1-9]\d{0,18}$/.test(String(badge.id)));
  if (!badges.length) return [];
  const ids = badges.map((badge) => String(badge.id));
  const icons = await robloxJson(
    `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${ids.join(",")}&size=150x150&format=Png&isCircular=false`,
  );
  const iconUrls = new Map((icons.data ?? []).map((icon) => [String(icon.targetId), icon.imageUrl]));
  return badges.map((badge) => ({
    ...badge,
    icon: iconUrls.get(String(badge.id)) ?? null,
  }));
}

async function gameRecommendations(universeId) {
  const result = await robloxJson(
    `https://games.roblox.com/v1/games/recommendations/game/${universeId}`,
  );
  const games = (result.games ?? result.data ?? [])
    .map((game) => ({
      placeId: String(game.rootPlaceId || game.placeId || ""),
      universeId: String(game.universeId || game.id || ""),
      name: game.name,
      creator: game.creatorName || game.creator?.name || null,
      players: game.playerCount ?? game.playing,
      thumb: game.thumbnailUrl || game.imageUrl || null,
    }))
    .filter((game) =>
      /^[1-9]\d{0,18}$/.test(game.placeId) &&
      /^[1-9]\d{0,18}$/.test(game.universeId),
    )
    .slice(0, 10);
  const missingThumbs = games.filter((game) => !game.thumb).map((game) => game.universeId);
  const thumbs = await gameThumbs([...new Set(missingThumbs)]);
  return games.map((game) => ({
    ...game,
    thumb: game.thumb || thumbs.get(game.universeId) || null,
  }));
}

function play(placeId, game, serverId = null) {
  if (game) rememberGame({ ...game, placeId });
  const url = new URL(location.href);
  const params = new URLSearchParams({ placeId });
  if (serverId) params.set("gameInstanceId", serverId);
  url.search = `?${params}`;
  location.assign(url);
}

function gameCard(game, wide, onSelect) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = wide ? "game wide" : "game";
  const art = document.createElement("span");
  art.className = "art";
  const playIndicator = faIcon("circle-play");
  playIndicator.classList.add("game-play-indicator");
  playIndicator.setAttribute("aria-hidden", "true");
  art.append(playIndicator);
  if (game.thumb) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = game.thumb;
    art.append(image);
  }
  if (game.badge) {
    const badge = document.createElement("span");
    badge.className = "game-badge";
    badge.textContent = game.badge;
    art.append(badge);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = game.name || `Experience ${game.placeId}`;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [game.creator, playing(game.players)].filter(Boolean).join(" · ");
  button.append(art, name, meta);
  button.addEventListener("click", () => onSelect(game));
  item.append(button);
  return item;
}

function faIcon(name) {
  const icon = document.createElement("i");
  icon.className = `fa-solid fa-${name} ui-icon`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function setIconLabel(element, icon, label) {
  element.replaceChildren(faIcon(icon), document.createTextNode(label));
}

function gameSection(title, games, { wide = false, grid = false, onSelect = (game) => play(game.placeId, game) } = {}) {
  const block = document.createElement("section");
  block.className = "row";
  if (title === "Continue") block.id = "continue";
  if (title) {
    const heading = document.createElement("h2");
    const icon = /continue|recent/i.test(title)
      ? "clock-rotate-left"
      : /trending|popular/i.test(title)
        ? "fire"
        : /favorite|saved/i.test(title)
          ? "heart"
          : "gamepad";
    heading.append(faIcon(icon), document.createTextNode(title));
    block.append(heading);
  }
  const list = document.createElement("ul");
  list.className = grid ? "cards grid" : wide ? "cards wide" : "cards";
  for (const game of games) list.append(gameCard(game, wide, onSelect));
  block.append(list);
  return block;
}

const LOGO_MARK = `<svg viewBox="0 0 32 32" aria-hidden="true" class="brand-mark"><g transform="rotate(-9 16 16)"><rect x="3" y="3" width="26" height="26" rx="6" fill="#e2231a"/><rect x="11" y="11" width="10" height="10" rx="2" fill="#fff"/></g></svg>`;
const HOME_LAYOUT = `
  <div class="home">
    <header class="top">
      <a class="brand" href="./" aria-label="Roblox home">${LOGO_MARK}<span>Roblox</span></a>
      <form class="search" role="search">
        <label class="sr-only" for="home-search">Search games</label>
        <i class="fa-solid fa-magnifying-glass search-icon" aria-hidden="true"></i>
        <input id="home-search" type="search" placeholder="Search games or paste a game link" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="search-suggestions" aria-expanded="false">
        <button type="button" class="search-clear" aria-label="Clear search" title="Clear search" hidden><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        <div id="search-suggestions" class="search-suggestions" role="listbox" aria-label="Quick search suggestions" hidden></div>
        <button type="submit" class="sr-only">Search</button>
      </form>
      <span class="currency-balance" hidden aria-live="polite">
        <i class="fa-solid fa-coins" aria-hidden="true"></i>
        <span class="currency-symbol" aria-hidden="true">R$</span>
        <span class="currency-value"></span>
      </span>
      <div class="account-controls">
        <button type="button" class="account-button" aria-haspopup="true" aria-expanded="false">
          <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i>Sign in
        </button>
        <section class="account-menu" aria-label="Account and appearance" hidden>
          <p class="account-menu-title">Accounts</p>
          <div class="saved-account-list"></div>
          <p class="account-menu-note">Saved sessions stay in this browser. Log out removes the current session from this launcher.</p>
          <button type="button" class="account-menu-action add-account"><i class="fa-solid fa-user-plus" aria-hidden="true"></i>Add account</button>
          <label class="theme-picker" for="theme-select">
            <span><i class="fa-solid fa-palette" aria-hidden="true"></i>Theme</span>
            <select id="theme-select" aria-label="Choose theme">
              <option value="red">Red</option>
              <option value="blue">Blue</option>
              <option value="pink">Pink</option>
              <option value="purple">Purple</option>
              <option value="green">Green</option>
              <option value="orange">Orange</option>
            </select>
          </label>
          <button type="button" class="account-menu-action logout-account" hidden><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>Log out</button>
          <p class="account-menu-status" role="status"></p>
        </section>
      </div>
    </header>
    <div class="workspace">
      <aside class="sidebar">
        <nav class="site-nav" aria-label="Main navigation">
          <button type="button" class="nav-button active" data-page="home"><i class="fa-solid fa-house" aria-hidden="true"></i>Home</button>
          <button type="button" class="nav-button" data-page="discover"><i class="fa-solid fa-compass" aria-hidden="true"></i>Discover</button>
          <button type="button" class="nav-button" data-page="saved"><i class="fa-solid fa-heart" aria-hidden="true"></i>Favorites</button>
          <button type="button" class="nav-button" data-page="friends"><i class="fa-solid fa-user-group" aria-hidden="true"></i>Friends</button>
          <button style="display: none;" type="button" class="sidebar-shortcut" data-scroll="continue"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>Continue</button>
        </nav>
      </aside>
      <main class="feed">
        <p class="feed-status" role="status"></p>
        <div class="feed-body"></div>
      </main>
    </div>
    <dialog class="game-dialog" aria-labelledby="game-dialog-title">
      <button type="button" class="dialog-close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      <div class="dialog-art"></div>
      <h1 id="game-dialog-title"></h1>
      <p class="dialog-meta"></p>
      <p class="dialog-description" role="status">Loading description…</p>
      <div class="dialog-actions">
        <button type="button" class="primary join-game"><i class="fa-solid fa-play" aria-hidden="true"></i>Play</button>
        <button type="button" class="servers-toggle"><i class="fa-solid fa-server" aria-hidden="true"></i>Servers</button>
        <button type="button" class="quick-join-low"><i class="fa-solid fa-bolt" aria-hidden="true"></i>Quick join</button>
        <button type="button" class="copy-game-link"><i class="fa-solid fa-link" aria-hidden="true"></i>Copy link</button>
        <button type="button" class="share-game"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i>Share</button>
      </div>
      <p class="dialog-action-status" role="status"></p>
      <section class="game-badges">
        <h2><i class="fa-solid fa-award" aria-hidden="true"></i>Badges</h2>
        <p class="game-badges-status" role="status">Loading badges…</p>
        <ul class="game-badge-list"></ul>
      </section>
      <section class="game-recommendations" hidden>
        <h2><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>More like this</h2>
        <p class="game-recommendations-status" role="status"></p>
        <ul class="cards"></ul>
      </section>
      <section class="server-browser" hidden>
        <h2><i class="fa-solid fa-server" aria-hidden="true"></i>Public servers</h2>
        <label class="server-sort-label"><i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i>Sort by
          <select class="server-sort">
            <option value="Asc">Fewest players</option>
            <option value="Desc">Most players</option>
          </select>
        </label>
        <p class="server-status" role="status"></p>
        <ul class="server-list"></ul>
        <button type="button" class="load-more" hidden><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>Load more</button>
      </section>
    </dialog>
    <dialog class="user-dialog" aria-labelledby="user-dialog-name">
      <button type="button" class="user-dialog-close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      <header class="user-profile-hero">
        <img class="user-dialog-avatar" alt="">
        <div class="user-profile-identity">
          <h2 id="user-dialog-name"></h2>
          <p class="user-dialog-username"></p>
          <span class="user-profile-verified" hidden><i class="fa-solid fa-circle-check" aria-hidden="true"></i>Verified</span>
          <p class="user-dialog-presence"></p>
        </div>
      </header>
      <p class="user-dialog-id"></p>
      <p class="user-profile-description"></p>
      <p class="user-profile-created"></p>
      <dl class="user-profile-counts">
        <div><dt>Friends</dt><dd class="profile-friends-count">—</dd></div>
        <div><dt>Followers</dt><dd class="profile-followers-count">—</dd></div>
        <div><dt>Following</dt><dd class="profile-following-count">—</dd></div>
      </dl>
      <section class="user-profile-section user-profile-avatar-details">
        <h3><i class="fa-solid fa-user-astronaut" aria-hidden="true"></i>Avatar</h3>
        <p class="profile-avatar-rig"></p>
        <div class="profile-body-colors"></div>
        <ul class="profile-avatar-assets"></ul>
        <h4><i class="fa-solid fa-face-smile" aria-hidden="true"></i>Equipped emotes</h4>
        <ul class="profile-emotes"></ul>
        <p class="profile-avatar-status"></p>
      </section>
      <section class="user-profile-section user-profile-games">
        <h3><i class="fa-solid fa-gamepad" aria-hidden="true"></i>Public experiences</h3>
        <p class="profile-games-status"></p>
        <div class="profile-game-list"></div>
      </section>
      <section class="user-profile-section user-profile-groups">
        <h3><i class="fa-solid fa-people-group" aria-hidden="true"></i>Groups</h3>
        <p class="profile-groups-status"></p>
        <ul class="profile-group-list"></ul>
      </section>
      <button type="button" class="user-dialog-join" hidden><i class="fa-solid fa-gamepad" aria-hidden="true"></i>Join</button>
      <div class="user-dialog-actions">
        <button type="button" class="copy-username"><i class="fa-solid fa-copy" aria-hidden="true"></i>Copy username</button>
        <button type="button" class="copy-profile-link"><i class="fa-solid fa-link" aria-hidden="true"></i>Copy profile link</button>
      </div>
      <p class="user-dialog-status" role="status"></p>
    </dialog>
    <dialog class="group-dialog" aria-labelledby="group-dialog-name">
      <button type="button" class="group-dialog-close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      <header class="group-dialog-header">
        <span class="group-dialog-icon"><i class="fa-solid fa-people-group" aria-hidden="true"></i></span>
        <div>
          <h2 id="group-dialog-name"></h2>
          <p class="group-dialog-owner"></p>
        </div>
        <span class="group-dialog-verified" hidden><i class="fa-solid fa-circle-check" aria-hidden="true"></i>Verified</span>
      </header>
      <p class="group-dialog-description"></p>
      <dl class="group-dialog-counts">
        <div><dt>Members</dt><dd class="group-member-count">—</dd></div>
        <div><dt>Roles</dt><dd class="group-role-count">—</dd></div>
        <div><dt>Status</dt><dd class="group-status-label">—</dd></div>
      </dl>
      <section class="group-dialog-section">
        <h3><i class="fa-solid fa-bullhorn" aria-hidden="true"></i>Group shout</h3>
        <p class="group-dialog-shout">Loading group…</p>
      </section>
      <section class="group-dialog-section">
        <h3><i class="fa-solid fa-ranking-star" aria-hidden="true"></i>Roles</h3>
        <p class="group-roles-status" role="status"></p>
        <ul class="group-role-list"></ul>
      </section>
      <section class="group-dialog-section">
        <h3><i class="fa-solid fa-users" aria-hidden="true"></i>Members</h3>
        <p class="group-members-status" role="status"></p>
        <ul class="group-members-list"></ul>
        <button type="button" class="group-members-more" hidden>Load more members</button>
      </section>
      <p class="group-dialog-status" role="status"></p>
    </dialog>
  </div>`;

function showLauncher() {
  document.getElementById("loading-overlay").hidden = true;
  document.body.insertAdjacentHTML("beforeend", HOME_LAYOUT);
  const home = document.querySelector(".home");
  const form = home.querySelector(".search");
  const input = home.querySelector("input");
  const suggestions = home.querySelector(".search-suggestions");
  const clearSearchButton = home.querySelector(".search-clear");
  const status = home.querySelector(".feed-status");
  const feed = home.querySelector(".feed-body");
  const navButtons = [...home.querySelectorAll(".nav-button")];
  const accountButton = home.querySelector(".account-button");
  const accountMenu = home.querySelector(".account-menu");
  const savedAccountList = home.querySelector(".saved-account-list");
  const accountMenuStatus = home.querySelector(".account-menu-status");
  const addAccountButton = home.querySelector(".add-account");
  const logoutButton = home.querySelector(".logout-account");
  const themeSelect = home.querySelector("#theme-select");
  const currencyBalance = home.querySelector(".currency-balance");
  const currencyValue = home.querySelector(".currency-value");
  const dialog = home.querySelector(".game-dialog");
  const userDialog = home.querySelector(".user-dialog");
  const groupDialog = home.querySelector(".group-dialog");
  const userDialogAvatar = userDialog.querySelector(".user-dialog-avatar");
  const userDialogName = userDialog.querySelector("#user-dialog-name");
  const userDialogUsername = userDialog.querySelector(".user-dialog-username");
  const userDialogPresence = userDialog.querySelector(".user-dialog-presence");
  const userDialogId = userDialog.querySelector(".user-dialog-id");
  const userDialogDescription = userDialog.querySelector(".user-profile-description");
  const userDialogCreated = userDialog.querySelector(".user-profile-created");
  const userDialogVerified = userDialog.querySelector(".user-profile-verified");
  const userDialogJoin = userDialog.querySelector(".user-dialog-join");
  const userDialogStatus = userDialog.querySelector(".user-dialog-status");
  const profileAvatarRig = userDialog.querySelector(".profile-avatar-rig");
  const profileBodyColors = userDialog.querySelector(".profile-body-colors");
  const profileAvatarAssets = userDialog.querySelector(".profile-avatar-assets");
  const profileEmotes = userDialog.querySelector(".profile-emotes");
  const profileAvatarStatus = userDialog.querySelector(".profile-avatar-status");
  const profileGamesStatus = userDialog.querySelector(".profile-games-status");
  const profileGameList = userDialog.querySelector(".profile-game-list");
  const profileGroupsStatus = userDialog.querySelector(".profile-groups-status");
  const profileGroupList = userDialog.querySelector(".profile-group-list");
  const groupDialogName = groupDialog.querySelector("#group-dialog-name");
  const groupDialogOwner = groupDialog.querySelector(".group-dialog-owner");
  const groupDialogDescription = groupDialog.querySelector(".group-dialog-description");
  const groupDialogVerified = groupDialog.querySelector(".group-dialog-verified");
  const groupMemberCount = groupDialog.querySelector(".group-member-count");
  const groupRoleCount = groupDialog.querySelector(".group-role-count");
  const groupStatusLabel = groupDialog.querySelector(".group-status-label");
  const groupDialogShout = groupDialog.querySelector(".group-dialog-shout");
  const groupRolesStatus = groupDialog.querySelector(".group-roles-status");
  const groupRoleList = groupDialog.querySelector(".group-role-list");
  const groupMembersStatus = groupDialog.querySelector(".group-members-status");
  const groupMembersList = groupDialog.querySelector(".group-members-list");
  const groupMembersMore = groupDialog.querySelector(".group-members-more");
  const groupDialogStatus = groupDialog.querySelector(".group-dialog-status");
  const copyUsernameButton = userDialog.querySelector(".copy-username");
  const copyProfileLinkButton = userDialog.querySelector(".copy-profile-link");
  const dialogTitle = dialog.querySelector("#game-dialog-title");
  const dialogMeta = dialog.querySelector(".dialog-meta");
  const dialogDescription = dialog.querySelector(".dialog-description");
  const dialogArt = dialog.querySelector(".dialog-art");
  const joinButton = dialog.querySelector(".join-game");
  const quickJoinButton = dialog.querySelector(".quick-join-low");
  const copyGameLinkButton = dialog.querySelector(".copy-game-link");
  const shareGameButton = dialog.querySelector(".share-game");
  const dialogActionStatus = dialog.querySelector(".dialog-action-status");
  const favoriteButton = document.createElement("button");
  favoriteButton.type = "button";
  favoriteButton.className = "favorite-toggle";
  favoriteButton.setAttribute("aria-pressed", "false");
  setIconLabel(favoriteButton, "bookmark", "Save");
  dialog.querySelector(".dialog-actions").append(favoriteButton);
  const serversToggle = dialog.querySelector(".servers-toggle");
  const badgesStatus = dialog.querySelector(".game-badges-status");
  const badgesList = dialog.querySelector(".game-badge-list");
  const recommendationsSection = dialog.querySelector(".game-recommendations");
  const recommendationsStatus = dialog.querySelector(".game-recommendations-status");
  const recommendationsList = recommendationsSection.querySelector(".cards");
  const serverBrowser = dialog.querySelector(".server-browser");
  const serverStatus = dialog.querySelector(".server-status");
  const serverSort = dialog.querySelector(".server-sort");
  const serverList = dialog.querySelector(".server-list");
  const loadMore = dialog.querySelector(".load-more");
  let current = 0;
  let page = "home";
  let sessionActivation = null;
  let sessionAvailable = false;
  let selectedGame = null;
  let selectedFriend = null;
  let serverCursor = "";
  let serverRequest = 0;
  let balanceRequest = 0;
  let profileRequest = 0;
  let groupRequest = 0;
  let selectedGroupId = null;
  let groupMemberCursor = null;
  let activeAccountId = null;
  let activeAccountName = "";

  const savedTheme = (() => {
    try {
      const theme = localStorage.getItem(THEME_KEY);
      return THEMES.has(theme) ? theme : "blue";
    } catch {
      return "blue";
    }
  })();
  themeSelect.value = savedTheme;
  home.dataset.theme = savedTheme;

  function setAccountButtonLabel(label, signedIn = false) {
    setIconLabel(accountButton, signedIn ? "circle-check" : "right-to-bracket", label);
    accountButton.setAttribute("aria-expanded", String(!accountMenu.hidden));
  }

  function renderAccountMenu() {
    savedAccountList.replaceChildren();
    for (const account of readAccounts()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "saved-account";
      item.disabled = account.id === activeAccountId;
      item.addEventListener("click", () => void switchAccount(account));
      if (account.avatar) {
        const avatar = document.createElement("img");
        avatar.src = account.avatar;
        avatar.alt = "";
        item.append(avatar);
      } else {
        item.append(faIcon("user"));
      }
      const label = document.createElement("span");
      label.textContent = account.displayName || account.name;
      item.append(label);
      if (account.id === activeAccountId) {
        const currentLabel = document.createElement("small");
        currentLabel.textContent = "Current";
        item.append(currentLabel);
      }
      savedAccountList.append(item);
    }
    setIconLabel(addAccountButton, sessionAvailable ? "user-plus" : "right-to-bracket", sessionAvailable ? "Add account" : "Sign in");
    logoutButton.hidden = !sessionAvailable;
  }

  function resetAccountRequests() {
    authenticatedAccountRequest = null;
    authenticatedProfileRequest = null;
    sessionActivation = null;
    balanceRequest += 1;
  }

  async function saveActiveAccount() {
    const account = await authenticatedUser();
    rememberAccount(account);
    activeAccountId = String(account.id);
    activeAccountName = account.displayName || account.name || `User ${account.id}`;
    setAccountButtonLabel(activeAccountName, true);
    renderAccountMenu();
  }

  function toggleAccountMenu(open = accountMenu.hidden) {
    accountMenu.hidden = !open;
    accountButton.setAttribute("aria-expanded", String(open));
    if (open) (accountMenu.querySelector(".saved-account:not(:disabled)") ?? addAccountButton).focus();
  }

  async function switchAccount(account) {
    if (account.id === activeAccountId) {
      toggleAccountMenu(false);
      return;
    }
    current += 1;
    profileRequest += 1;
    const previousSession = savedSession();
    const previousManual = localStorage.getItem(MANUAL_KEY) === "1";
    accountMenuStatus.textContent = `Switching to ${account.displayName || account.name}…`;
    try {
      storeSession(account.session, true);
      if (!(await sessionAccepted())) throw new Error("That saved Roblox session has expired. Add the account again.");
      resetAccountRequests();
      const verified = await authenticatedUser();
      if (String(verified.id) !== account.id) throw new Error("Roblox returned a different account than the one selected.");
      localStorage.removeItem(LOGGED_OUT_KEY);
      sessionAvailable = true;
      activeAccountId = account.id;
      activeAccountName = account.displayName || account.name;
      accountMenuStatus.textContent = "";
      toggleAccountMenu(false);
      setAccountButtonLabel(activeAccountName, true);
      renderAccountMenu();
      void saveActiveAccount().catch((error) => {
        accountMenuStatus.textContent = `Couldn't refresh account details: ${error?.message || error}`;
      });
      void refreshBalance();
      await loadHome({ syncSession: false });
    } catch (error) {
      if (previousSession) storeSession(previousSession, previousManual);
      else forgetSession();
      resetAccountRequests();
      accountMenuStatus.textContent = `Couldn't switch accounts: ${error?.message || error}`;
      renderAccountMenu();
    }
  }

  async function copyText(text) {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable in this browser context.");
    }
    await navigator.clipboard.writeText(text);
  }

  async function refreshBalance() {
    if (!sessionAvailable) return;
    const request = ++balanceRequest;
    currencyBalance.hidden = false;
    currencyBalance.title = "Loading Robux balance";
    currencyValue.textContent = "…";
    try {
      const balance = await robuxBalance();
      if (request !== balanceRequest) return;
      currencyValue.textContent = new Intl.NumberFormat("en").format(balance);
      currencyBalance.title = `${new Intl.NumberFormat("en").format(balance)} Robux`;
      currencyBalance.setAttribute("aria-label", `${new Intl.NumberFormat("en").format(balance)} Robux`);
    } catch (error) {
      if (request !== balanceRequest) return;
      currencyValue.textContent = "Unavailable";
      currencyBalance.title = `Couldn't load Robux balance: ${error?.message || error}`;
      currencyBalance.setAttribute("aria-label", "Robux balance unavailable");
    }
  }

  function showFriendDetails(friend) {
    selectedFriend = friend;
    const userId = String(friend.id);
    const request = ++profileRequest;
    const joinTarget = friendJoinTarget(friend);
    userDialogAvatar.hidden = !friend.avatar;
    if (friend.avatar) userDialogAvatar.src = friend.avatar;
    else userDialogAvatar.removeAttribute("src");
    userDialogName.textContent = friend.displayName || friend.name || `User ${userId}`;
    userDialogUsername.textContent = friend.name ? `@${friend.name}` : "";
    const presenceKnown = friend.presence || typeof friend.isOnline === "boolean";
    userDialogPresence.textContent = presenceKnown ? friendPresenceLabel(friend) : "Presence unavailable";
    userDialogPresence.classList.remove("presence-in-game", "presence-online", "presence-offline");
    if (presenceKnown) userDialogPresence.classList.add(friendPresenceClass(friend));
    userDialogId.textContent = `User ID: ${userId}`;
    userDialogDescription.textContent = "Loading profile…";
    userDialogCreated.textContent = "";
    userDialogVerified.hidden = true;
    for (const selector of [".profile-friends-count", ".profile-followers-count", ".profile-following-count"]) {
      userDialog.querySelector(selector).textContent = "…";
    }
    profileAvatarRig.textContent = "Loading avatar details…";
    profileBodyColors.replaceChildren();
    profileAvatarAssets.replaceChildren();
    profileEmotes.replaceChildren();
    profileAvatarStatus.textContent = "";
    profileGamesStatus.textContent = "Loading public experiences…";
    profileGameList.replaceChildren();
    profileGroupsStatus.textContent = "Loading groups…";
    profileGroupList.replaceChildren();
    userDialogStatus.textContent = "";
    userDialogJoin.hidden = !joinTarget;
    userDialogJoin.onclick = joinTarget
      ? () => play(joinTarget.placeId, { placeId: joinTarget.placeId }, joinTarget.serverId)
      : null;
    userDialog.showModal();
    if (!/^[1-9]\d{0,18}$/.test(userId)) {
      userDialogStatus.textContent = "This profile has an invalid user ID.";
      return;
    }
    void userProfileData(userId).then((profile) => {
      if (request !== profileRequest || !userDialog.open) return;
      selectedFriend = { ...selectedFriend, ...profile.user };
      userDialogName.textContent = profile.user.displayName || profile.user.name || `User ${userId}`;
      userDialogUsername.textContent = profile.user.name ? `@${profile.user.name}` : "";
      userDialogId.textContent = `User ID: ${userId}`;
      userDialogPresence.textContent = presenceKnown ? friendPresenceLabel(friend) : "Presence unavailable";
      userDialogDescription.textContent = profile.user.description?.trim() || "No description provided.";
      userDialogCreated.textContent = profile.user.created
        ? `Joined ${new Date(profile.user.created).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })}`
        : "Join date unavailable";
      userDialogVerified.hidden = profile.user.hasVerifiedBadge !== true;
      if (profile.avatarThumbnail) {
        userDialogAvatar.src = profile.avatarThumbnail;
        userDialogAvatar.hidden = false;
      }

      const countValue = (result) => {
        if (result.status !== "fulfilled" || !Number.isFinite(Number(result.value.count))) return "Unavailable";
        return new Intl.NumberFormat().format(Number(result.value.count));
      };
      userDialog.querySelector(".profile-friends-count").textContent = countValue(profile.counts.friends);
      userDialog.querySelector(".profile-followers-count").textContent = countValue(profile.counts.followers);
      userDialog.querySelector(".profile-following-count").textContent = countValue(profile.counts.following);

      if (profile.avatar) {
        const model = profile.avatar;
        const scales = model.scales ?? {};
        const scaleSummary = ["height", "width", "head", "depth"]
          .filter((key) => Number.isFinite(Number(scales[key])))
          .map((key) => `${key[0].toUpperCase()}${key.slice(1)} ${Number(scales[key]).toFixed(2)}`);
        profileAvatarRig.textContent = [
          model.playerAvatarType || "Avatar",
          ...scaleSummary,
        ].join(" · ");
        for (const [part, color] of Object.entries(model.bodyColors ?? {})) {
          if (!/^[0-9a-f]{6}$/i.test(String(color))) continue;
          const swatch = document.createElement("span");
          swatch.className = "profile-body-color";
          swatch.title = `${part}: #${color}`;
          swatch.setAttribute("aria-label", `${part} color`);
          swatch.style.setProperty("--avatar-color", `#${color}`);
          profileBodyColors.append(swatch);
        }
        const assets = model.assets ?? [];
        for (const asset of assets) {
          const item = document.createElement("li");
          const name = document.createElement("strong");
          name.textContent = asset.name || `Asset ${asset.id}`;
          const type = document.createElement("span");
          type.textContent = asset.assetType?.name || "Avatar item";
          item.append(name, type);
          profileAvatarAssets.append(item);
        }
        if (!assets.length) profileAvatarStatus.textContent = "No equipped avatar items were returned.";
        for (const emote of profile.avatarConfigurations?.emotes ?? []) {
          const item = document.createElement("li");
          item.textContent = emote.assetName || `Emote ${emote.assetId}`;
          profileEmotes.append(item);
        }
        if (!profileEmotes.childElementCount) {
          const item = document.createElement("li");
          item.textContent = "No equipped emotes";
          profileEmotes.append(item);
        }
      } else {
        profileAvatarRig.textContent = "Avatar details unavailable.";
        profileAvatarStatus.textContent = profile.avatarError
          ? `Couldn't load avatar details: ${profile.avatarError?.message || profile.avatarError}`
          : "";
      }

      if (profile.gamesError) {
        profileGamesStatus.textContent = `Couldn't load public experiences: ${profile.gamesError?.message || profile.gamesError}`;
      } else {
        profileGamesStatus.textContent = profile.games.length
          ? `${profile.games.length} public experience${profile.games.length === 1 ? "" : "s"}`
          : "No public experiences found.";
        if (profile.games.length) {
          profileGameList.append(gameSection("", profile.games, {
            grid: true,
            onSelect: showGameDetails,
          }));
        }
      }

      if (profile.groupsError) {
        profileGroupsStatus.textContent = `Couldn't load groups: ${profile.groupsError?.message || profile.groupsError}`;
      } else {
        const groups = profile.groups.map((entry) => entry.group).filter(Boolean);
        profileGroupsStatus.textContent = groups.length
          ? `${groups.length} group${groups.length === 1 ? "" : "s"}`
          : "No groups found.";
        for (const entry of profile.groups) {
          const group = entry.group;
          if (!group) continue;
          const item = document.createElement("li");
          const open = document.createElement("button");
          open.type = "button";
          open.className = "profile-group-open";
          open.addEventListener("click", () => showGroupDetails(group));
          const name = document.createElement("strong");
          name.textContent = group.name || `Group ${group.id}`;
          const role = document.createElement("span");
          role.textContent = entry.role?.name || "Member";
          const members = document.createElement("span");
          members.textContent = Number.isFinite(Number(group.memberCount))
            ? `${new Intl.NumberFormat().format(Number(group.memberCount))} members`
            : "";
          open.append(name, role, members);
          item.append(open);
          profileGroupList.append(item);
        }
      }
    }).catch((error) => {
      if (request === profileRequest && userDialog.open) {
        userDialogStatus.textContent = `Couldn't load profile: ${error?.message || error}`;
      }
    });
  }

  async function showGroupDetails(group) {
    const groupId = String(group?.id ?? "");
    const request = ++groupRequest;
    selectedGroupId = groupId;
    groupMemberCursor = null;
    groupDialogName.textContent = group?.name || "Group";
    groupDialogOwner.textContent = "";
    groupDialogDescription.textContent = "Loading group details…";
    groupDialogVerified.hidden = true;
    groupMemberCount.textContent = "—";
    groupRoleCount.textContent = "—";
    groupStatusLabel.textContent = "—";
    groupDialogShout.textContent = "Loading group shout…";
    groupRolesStatus.textContent = "";
    groupRoleList.replaceChildren();
    groupMembersStatus.textContent = "";
    groupMembersList.replaceChildren();
    groupMembersMore.hidden = true;
    groupMembersMore.disabled = false;
    groupDialogStatus.textContent = "";
    groupDialog.showModal();
    if (!/^[1-9]\d{0,18}$/.test(groupId)) {
      groupDialogStatus.textContent = "This group has an invalid ID.";
      return;
    }
    try {
      const details = await groupPageData(groupId);
      if (request !== groupRequest || !groupDialog.open) return;
      const data = details.group;
      groupDialogName.textContent = data.name || `Group ${groupId}`;
      groupDialogOwner.textContent = data.owner
        ? `Owned by ${data.owner.displayName || data.owner.username || "Unknown"}`
        : "No owner information returned";
      groupDialogDescription.textContent = data.description?.trim() || "No description provided.";
      groupDialogVerified.hidden = data.hasVerifiedBadge !== true;
      groupMemberCount.textContent = Number.isFinite(Number(data.memberCount))
        ? new Intl.NumberFormat().format(Number(data.memberCount))
        : "Unavailable";
      groupRoleCount.textContent = details.roles.length
        ? new Intl.NumberFormat().format(details.roles.length)
        : details.rolesError ? "Unavailable" : "0";
      groupStatusLabel.textContent = data.isLocked
        ? "Locked"
        : data.publicEntryAllowed === false ? "Approval required" : "Open";
      const shout = data.shout;
      groupDialogShout.textContent = shout?.body?.trim()
        ? `${shout.body.trim()}${shout.poster?.username ? ` — ${shout.poster.username}` : ""}`
        : "No group shout.";

      if (details.rolesError) {
        groupRolesStatus.textContent = `Couldn't load roles: ${details.rolesError?.message || details.rolesError}`;
      } else {
        groupRolesStatus.textContent = `${details.roles.length} role${details.roles.length === 1 ? "" : "s"}`;
        for (const role of details.roles) {
          const item = document.createElement("li");
          const name = document.createElement("strong");
          name.textContent = role.name || "Unnamed role";
          const rank = document.createElement("span");
          rank.textContent = `Rank ${Number.isFinite(Number(role.rank)) ? role.rank : "—"}`;
          const count = document.createElement("span");
          count.textContent = Number.isFinite(Number(role.memberCount))
            ? `${new Intl.NumberFormat().format(Number(role.memberCount))} members`
            : "";
          item.append(name, rank, count);
          groupRoleList.append(item);
        }
      }

      if (details.membersError) {
        groupMembersStatus.textContent = `Couldn't load members: ${details.membersError?.message || details.membersError}`;
      } else {
        groupMemberCursor = details.memberCursor;
        groupMembersMore.hidden = !groupMemberCursor;
        groupMembersStatus.textContent = details.members.length
          ? `Showing ${groupMemberCursor ? "first " : ""}${details.members.length} members`
          : "No members returned.";
        for (const entry of details.members) {
          const user = entry.user ?? {};
          const item = document.createElement("li");
          const name = document.createElement("strong");
          name.textContent = user.displayName || user.username || `User ${user.userId || ""}`;
          const username = document.createElement("span");
          username.textContent = user.username ? `@${user.username}` : "";
          const role = document.createElement("span");
          role.textContent = entry.role?.name || "";
          item.append(name, username, role);
          groupMembersList.append(item);
        }
      }
    } catch (error) {
      if (request === groupRequest && groupDialog.open) {
        groupDialogStatus.textContent = `Couldn't load group: ${error?.message || error}`;
      }
    }
  }

  async function loadMoreGroupMembers() {
    if (!selectedGroupId || !groupMemberCursor) return;
    const groupId = selectedGroupId;
    const cursor = groupMemberCursor;
    const request = groupRequest;
    groupMembersMore.disabled = true;
    groupMembersStatus.textContent = "Loading more members…";
    try {
      const result = await groupMembersPage(groupId, cursor);
      if (request !== groupRequest || !groupDialog.open) return;
      for (const entry of result.data ?? []) {
        const user = entry.user ?? {};
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = user.displayName || user.username || `User ${user.userId || ""}`;
        const username = document.createElement("span");
        username.textContent = user.username ? `@${user.username}` : "";
        const role = document.createElement("span");
        role.textContent = entry.role?.name || "";
        item.append(name, username, role);
        groupMembersList.append(item);
      }
      groupMemberCursor = result.nextPageCursor ?? null;
      groupMembersMore.hidden = !groupMemberCursor;
      groupMembersStatus.textContent = `${groupMembersList.childElementCount} members shown`;
    } catch (error) {
      if (request === groupRequest && groupDialog.open) {
        groupMembersStatus.textContent = `Couldn't load more members: ${error?.message || error}`;
      }
    } finally {
      groupMembersMore.disabled = false;
    }
  }

  copyUsernameButton.addEventListener("click", async () => {
    if (!selectedFriend) return;
    try {
      await copyText(selectedFriend.name || String(selectedFriend.id));
      userDialogStatus.textContent = "Username copied.";
    } catch (error) {
      userDialogStatus.textContent = `Couldn't copy username: ${error?.message || error}`;
    }
  });
  copyProfileLinkButton.addEventListener("click", async () => {
    if (!selectedFriend) return;
    try {
      await copyText(`https://www.roblox.com/users/${selectedFriend.id}/profile`);
      userDialogStatus.textContent = "Profile link copied.";
    } catch (error) {
      userDialogStatus.textContent = `Couldn't copy profile link: ${error?.message || error}`;
    }
  });

  function activateKnownSession() {
    if (!sessionActivation) {
      sessionActivation = (async () => {
        if (localStorage.getItem(LOGGED_OUT_KEY) === "1") return null;
        const saved = savedSession();
        const manual = localStorage.getItem(MANUAL_KEY) === "1";
        const proxied = await proxySession();
        const order = manual ? [saved, proxied] : [proxied, saved];
        for (const value of new Set(order.filter(Boolean))) {
          try {
            if (await trySession(value, value === saved && manual)) {
              sessionAvailable = true;
              setAccountButtonLabel("Signed in", true);
              void refreshBalance();
              return null;
            }
          } catch (error) {
            return error?.message || String(error);
          }
        }
        return null;
      })();
    }
    return sessionActivation;
  }

  async function loadHome({ syncSession = true } = {}) {
    page = "home";
    form.hidden = false;
    navButtons.forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const ticket = ++current;
    status.textContent = "Loading Roblox…";
    feed.replaceChildren();
    let sessionWarning = null;
    if (syncSession) {
      try {
        sessionWarning = await activateKnownSession();
      } catch (error) {
        sessionWarning = error?.message || String(error);
      }
    }
    const friendsRequest = sessionAvailable ? friendData() : Promise.resolve([]);
    const profileSession = sessionAvailable ? savedSession() : null;
    const profileRequest = sessionAvailable ? authenticatedProfile() : Promise.resolve(null);
    const [recent, rows, friends, profile] = await Promise.allSettled([
      sessionAvailable ? localContinueGames() : Promise.resolve([]),
      sessionAvailable ? homeRows() : publicTrendingRow().then((row) => ({ continueList: [], rows: [row] })),
      friendsRequest,
      profileRequest,
    ]);
    if (ticket !== current) return;
    if (profile.status === "fulfilled" && profile.value) {
      try {
        rememberAccount(profile.value, profileSession);
        activeAccountId = String(profile.value.id);
        activeAccountName = profile.value.displayName || profile.value.name || `User ${profile.value.id}`;
        setAccountButtonLabel(activeAccountName, true);
        renderAccountMenu();
      } catch (error) {
        accountMenuStatus.textContent = `Couldn't save this account: ${error?.message || error}`;
      }
    }
    const sections = [];
    const remoteContinue = rows.status === "fulfilled" ? rows.value.continueList : [];
    const exploreRows = rows.status === "fulfilled" ? rows.value.rows : [];
    if (profile.status === "fulfilled" && profile.value) {
      sections.push(accountHeader(profile.value, showFriendDetails, loadFriends));
    }
    if (sessionAvailable && friends.status === "fulfilled") {
      sections.push(onlineFriendsSection(friends.value, {
        onSeeAll: loadFriends,
        onProfile: showFriendDetails,
        onJoin: (_friend, target) => play(target.placeId, { placeId: target.placeId }, target.serverId),
      }));
    }
    if (remoteContinue.length) sections.push(gameSection("Continue", remoteContinue, { wide: true, onSelect: showGameDetails }));
    else if (recent.status === "fulfilled" && recent.value.length) {
      sections.push(gameSection("Continue", recent.value, { wide: true, onSelect: showGameDetails }));
    }
    for (const row of exploreRows) {
      sections.push(gameSection(row.title, row.games, { onSelect: showGameDetails }));
    }
    feed.replaceChildren(...sections);
    if (rows.status === "rejected") {
      const feedName = sessionAvailable ? "Roblox's home feed" : "trending experiences";
      status.textContent = `Couldn't load ${feedName}: ${rows.reason?.message || rows.reason}`;
    } else if (sessionAvailable && friends.status === "rejected") {
      status.textContent = `Couldn't load online friends: ${friends.reason?.message || friends.reason}`;
    } else if (sessionAvailable && profile.status === "rejected") {
      status.textContent = `Couldn't load account overview: ${profile.reason?.message || profile.reason}`;
    } else if (sessionWarning) {
      status.textContent = `Couldn't verify the saved Roblox session: ${sessionWarning}`;
    } else if (!sections.length) {
      status.textContent = "Roblox did not return any experiences for this feed.";
    } else {
      status.textContent = "";
    }
  }

  async function loadDiscover() {
    page = "discover";
    form.hidden = false;
    navButtons.forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const ticket = ++current;
    status.textContent = "Finding experiences…";
    feed.replaceChildren();
    try {
      const rows = sessionAvailable ? (await homeRows()).rows : [await publicTrendingRow()];
      if (ticket !== current) return;
      const sections = [];
      for (const row of rows) {
        if (row.games.length) sections.push(gameSection(row.title, row.games, { onSelect: showGameDetails }));
      }
      feed.replaceChildren(...sections);
      status.textContent = sections.length ? "" : "No experiences are available right now.";
    } catch (error) {
      if (ticket === current) status.textContent = `Couldn't load Discover: ${error?.message || error}`;
    }
  }

  async function loadSaved() {
    page = "saved";
    form.hidden = true;
    navButtons.forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const ticket = ++current;
    const localFavorites = readFavorites();
    const sections = [];
    if (localFavorites.length) {
      sections.push(gameSection("Saved here", localFavorites, {
        grid: true,
        onSelect: showGameDetails,
      }));
    }
    feed.replaceChildren(...sections);
    status.textContent = "Loading your Roblox favorites…";
    try {
      if (!sessionAvailable) {
        await ensureSession();
        sessionAvailable = true;
        sessionActivation = Promise.resolve(null);
        setAccountButtonLabel("Signed in", true);
        void refreshBalance();
      }
      const favorites = await robloxFavoriteGames();
      if (ticket !== current) return;
      if (favorites.length) {
        sections.unshift(gameSection("Roblox favorites", favorites, {
          grid: true,
          onSelect: showGameDetails,
        }));
      }
      feed.replaceChildren(...sections);
      status.textContent = favorites.length
        ? `${favorites.length} Roblox favorites${localFavorites.length ? ` · ${localFavorites.length} saved here` : ""}`
        : localFavorites.length
          ? "No Roblox favorites found."
          : "No Roblox favorites or locally saved experiences.";
    } catch (error) {
      if (ticket === current) status.textContent = `Couldn't load Roblox favorites: ${error?.message || error}`;
    }
  }

  async function loadFriends() {
    page = "friends";
    form.hidden = true;
    navButtons.forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const ticket = ++current;
    status.textContent = "Loading friends…";
    feed.replaceChildren();
    try {
      if (!sessionAvailable) {
        await ensureSession();
        sessionAvailable = true;
        sessionActivation = Promise.resolve(null);
        setAccountButtonLabel("Signed in", true);
        void refreshBalance();
      }
      const friends = await friendData();
      if (ticket !== current) return;
      if (!friends.length) {
        status.textContent = "Your friends list is empty.";
        return;
      }
      const controls = document.createElement("div");
      controls.className = "friend-controls";
      const searchWrap = document.createElement("label");
      searchWrap.className = "friend-search-wrap";
      searchWrap.append(faIcon("magnifying-glass"));
      const search = document.createElement("input");
      search.type = "search";
      search.className = "friend-search";
      search.placeholder = "Find a friend";
      search.setAttribute("aria-label", "Find a friend");
      searchWrap.append(search);
      const filterWrap = document.createElement("label");
      filterWrap.className = "friend-filter-wrap";
      filterWrap.append(faIcon("filter"));
      const filter = document.createElement("select");
      filter.className = "friend-presence-filter";
      filter.setAttribute("aria-label", "Filter friends by presence");
      for (const [value, label] of [["all", "All friends"], ["online", "Online"], ["playing", "In an experience"], ["offline", "Offline"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        filter.append(option);
      }
      filterWrap.append(filter);
      controls.append(searchWrap, filterWrap);
      const list = document.createElement("ul");
      list.className = "friend-list";
      function renderFriendRows() {
        const query = search.value.trim().toLowerCase();
        const selectedFilter = filter.value;
        const visibleFriends = friends.filter((friend) => {
          const matchesQuery = [friend.displayName, friend.name, friend.id]
            .some((value) => String(value || "").toLowerCase().includes(query));
          const matchesFilter = selectedFilter === "all" ||
            (selectedFilter === "online" && isFriendOnline(friend)) ||
            (selectedFilter === "playing" && Number(friend.presence?.userPresenceType) === 2) ||
            (selectedFilter === "offline" && !isFriendOnline(friend));
          return matchesQuery && matchesFilter;
        });
        list.replaceChildren();
        for (const friend of visibleFriends) {
          const item = document.createElement("li");
          const avatar = document.createElement("img");
          avatar.className = "friend-avatar";
          avatar.alt = "";
          avatar.loading = "lazy";
          if (friend.avatar) avatar.src = friend.avatar;
          const identity = document.createElement("button");
          identity.type = "button";
          identity.className = "friend-identity friend-profile";
          identity.setAttribute("aria-label", `View ${friend.displayName || friend.name || `User ${friend.id}`}`);
          identity.addEventListener("click", () => showFriendDetails(friend));
          const displayName = document.createElement("strong");
          displayName.textContent = friend.displayName || friend.name || `User ${friend.id}`;
          const username = document.createElement("span");
          username.textContent = friend.name ? `@${friend.name}` : `User ID: ${friend.id}`;
          identity.append(displayName, username);
          const inGame = Number(friend.presence?.userPresenceType) === 2;
          const presenceText = document.createElement("span");
          presenceText.className = `friend-presence ${friendPresenceClass(friend)}`;
          presenceText.textContent = friendPresenceLabel(friend);
          item.append(avatar, identity, presenceText);
          const joinTarget = friendJoinTarget(friend);
          if (inGame && joinTarget) {
            const join = document.createElement("button");
            join.type = "button";
            join.className = "friend-join";
            setIconLabel(join, "gamepad", "Join");
            join.addEventListener("click", () => play(joinTarget.placeId, { placeId: joinTarget.placeId }, joinTarget.serverId));
            item.append(join);
          }
          list.append(item);
        }
        if (!visibleFriends.length) {
          const empty = document.createElement("li");
          empty.className = "friend-empty";
          empty.textContent = "No friends match those filters.";
          list.append(empty);
        }
        status.textContent = `${visibleFriends.length} of ${friends.length} friends`;
      }
      search.addEventListener("input", renderFriendRows);
      filter.addEventListener("change", renderFriendRows);
      feed.replaceChildren(controls, list);
      renderFriendRows();
    } catch (error) {
      if (ticket === current) status.textContent = `Couldn't load friends: ${error?.message || error}`;
    }
  }

  async function fetchServers(reset) {
    if (!selectedGame) return;
    const request = ++serverRequest;
    if (reset) {
      serverCursor = "";
      serverList.replaceChildren();
    }
    loadMore.hidden = true;
    serverStatus.textContent = "Loading public servers…";
    try {
      const result = await publicServers(selectedGame.placeId, reset ? "" : serverCursor, serverSort.value);
      if (request !== serverRequest) return;
      const servers = (result.data ?? []).filter((server) => /^[A-Za-z0-9-]{1,64}$/.test(String(server.id || "")));
      for (const server of servers) {
        const item = document.createElement("li");
        const details = document.createElement("span");
        details.textContent = `${Number(server.playing) || 0} of ${Number(server.maxPlayers) || "?"} players`;
        const join = document.createElement("button");
        join.type = "button";
        join.className = "server-join";
        setIconLabel(join, "gamepad", "Join");
        join.addEventListener("click", () => play(selectedGame.placeId, selectedGame, String(server.id)));
        item.append(details, join);
        serverList.append(item);
      }
      serverCursor = result.nextPageCursor || "";
      loadMore.hidden = !serverCursor;
      serverStatus.textContent = servers.length ? "" : serverList.childElementCount ? "" : "No public servers found.";
    } catch (error) {
      if (request === serverRequest) serverStatus.textContent = `Couldn't load public servers: ${error?.message || error}`;
    }
  }

  async function joinQuickServer() {
    const game = selectedGame;
    if (!game) return;
    quickJoinButton.disabled = true;
    setIconLabel(quickJoinButton, "spinner", "Finding…");
    quickJoinButton.querySelector("i").classList.add("fa-spin");
    dialogActionStatus.textContent = "Finding a low-population server…";
    try {
      const result = await publicServers(game.placeId, "", "Asc");
      if (selectedGame !== game || !dialog.open) return;
      const servers = (result.data ?? [])
        .filter((server) => /^[A-Za-z0-9-]{1,64}$/.test(String(server.id || "")))
        .sort((left, right) => (Number(left.playing) || 0) - (Number(right.playing) || 0));
      if (!servers.length) throw new Error("No public servers were found.");
      play(game.placeId, game, String(servers[0].id));
    } catch (error) {
      if (selectedGame === game) dialogActionStatus.textContent = `Couldn't quick join: ${error?.message || error}`;
    } finally {
      if (selectedGame === game) {
        quickJoinButton.disabled = false;
        setIconLabel(quickJoinButton, "bolt", "Quick join");
      }
    }
  }

  async function loadGameExtras(game) {
    badgesStatus.textContent = "Loading badges…";
    badgesList.replaceChildren();
    recommendationsSection.hidden = false;
    recommendationsStatus.textContent = "Loading recommendations…";
    recommendationsList.replaceChildren();
    try {
      const universeId = await universeIdForGame(game);
      const [badges, recommendations] = await Promise.allSettled([
        gameBadges(universeId),
        gameRecommendations(universeId),
      ]);
      if (selectedGame !== game) return;

      if (badges.status === "fulfilled") {
        badgesStatus.textContent = badges.value.length
          ? `${badges.value.length} badges`
          : "No badges found.";
        for (const badge of badges.value) {
          const item = document.createElement("li");
          if (badge.icon) {
            const image = document.createElement("img");
            image.src = badge.icon;
            image.alt = "";
            image.loading = "lazy";
            item.append(image);
          }
          const details = document.createElement("div");
          const name = document.createElement("strong");
          name.textContent = badge.name || "Badge";
          const description = document.createElement("span");
          description.textContent = badge.description || "";
          details.append(name, description);
          const awardedCount = Number(badge.statistics?.awardedCount);
          if (Number.isFinite(awardedCount)) {
            const awarded = document.createElement("span");
            awarded.className = "badge-awarded";
            awarded.textContent = `${COMPACT.format(awardedCount)} awarded`;
            details.append(awarded);
          }
          item.append(details);
          badgesList.append(item);
        }
      } else {
        badgesStatus.textContent = `Couldn't load badges: ${badges.reason?.message || badges.reason}`;
      }

      if (recommendations.status === "fulfilled") {
        recommendationsStatus.textContent = recommendations.value.length
          ? ""
          : "No recommendations found.";
        for (const recommendation of recommendations.value) {
          recommendationsList.append(gameCard(recommendation, false, showGameDetails));
        }
      } else {
        recommendationsStatus.textContent = `Couldn't load recommendations: ${recommendations.reason?.message || recommendations.reason}`;
      }
    } catch (error) {
      if (selectedGame !== game) return;
      badgesStatus.textContent = `Couldn't load badges: ${error?.message || error}`;
      recommendationsSection.hidden = false;
      recommendationsStatus.textContent = `Couldn't load recommendations: ${error?.message || error}`;
    }
  }

  function showGameDetails(game) {
    serverRequest += 1;
    selectedGame = game;
    const selected = game;
    dialogTitle.textContent = game.name || `Experience ${game.placeId}`;
    dialogMeta.textContent = [game.creator, playing(game.players)].filter(Boolean).join(" · ");
    dialogDescription.textContent = game.description || "Loading description…";
    dialogArt.replaceChildren();
    if (game.thumb) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = game.thumb;
      dialogArt.append(image);
    }
    serverBrowser.hidden = true;
    serverList.replaceChildren();
    serverStatus.textContent = "";
    loadMore.hidden = true;
    serverSort.value = readServerSort();
    dialogActionStatus.textContent = "";
    quickJoinButton.disabled = false;
    setIconLabel(quickJoinButton, "bolt", "Quick join");
    void loadGameExtras(game);
    joinButton.onclick = () => play(game.placeId, game);
    const saved = readFavorites().some((item) => item.placeId === game.placeId);
    setIconLabel(favoriteButton, saved ? "check" : "bookmark", saved ? "Saved" : "Save");
    favoriteButton.setAttribute("aria-pressed", String(saved));
    serversToggle.onclick = () => {
      serverBrowser.hidden = !serverBrowser.hidden;
      if (!serverBrowser.hidden && !serverList.childElementCount) fetchServers(true);
    };
    dialog.showModal();
    if (!game.description || !game.name || !game.creator) {
      experienceDetail(game).then((detail) => {
        if (selectedGame !== selected) return;
        if (!game.description) dialogDescription.textContent = detail.description || "No description provided.";
        if (!game.name && detail.name) dialogTitle.textContent = detail.name;
        if (!game.creator && detail.creatorName) {
          dialogMeta.textContent = [detail.creatorName, playing(game.players)].filter(Boolean).join(" · ");
        }
      }).catch((error) => {
        if (selectedGame === selected && !game.description) {
          dialogDescription.textContent = `Couldn't load description: ${error?.message || error}`;
        }
      });
    }
  }

  favoriteButton.addEventListener("click", () => {
    if (!selectedGame) return;
    try {
      const favorites = readFavorites();
      const exists = favorites.some((item) => item.placeId === selectedGame.placeId);
      const next = exists
        ? favorites.filter((item) => item.placeId !== selectedGame.placeId)
        : [{ ...selectedGame }, ...favorites];
      writeFavorites(next);
      setIconLabel(favoriteButton, exists ? "bookmark" : "check", exists ? "Save" : "Saved");
      favoriteButton.setAttribute("aria-pressed", String(!exists));
      if (page === "saved") loadSaved();
    } catch (error) {
      status.textContent = `Couldn't update saved experiences: ${error?.message || error}`;
    }
  });

  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  userDialog.querySelector(".user-dialog-close").addEventListener("click", () => userDialog.close());
  userDialog.addEventListener("click", (event) => {
    if (event.target === userDialog) userDialog.close();
  });
  groupDialog.querySelector(".group-dialog-close").addEventListener("click", () => groupDialog.close());
  groupDialog.addEventListener("click", (event) => {
    if (event.target === groupDialog) groupDialog.close();
  });
  groupMembersMore.addEventListener("click", loadMoreGroupMembers);
  quickJoinButton.addEventListener("click", joinQuickServer);
  copyGameLinkButton.addEventListener("click", async () => {
    if (!selectedGame) return;
    try {
      await copyText(`https://www.roblox.com/games/${selectedGame.placeId}`);
      dialogActionStatus.textContent = "Experience link copied.";
    } catch (error) {
      dialogActionStatus.textContent = `Couldn't copy experience link: ${error?.message || error}`;
    }
  });
  shareGameButton.addEventListener("click", async () => {
    if (!selectedGame) return;
    const url = `https://www.roblox.com/games/${selectedGame.placeId}`;
    try {
      if (navigator.share) await navigator.share({ title: selectedGame.name || "Roblox experience", url });
      else {
        await copyText(url);
        dialogActionStatus.textContent = "Experience link copied.";
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        dialogActionStatus.textContent = `Couldn't share experience: ${error?.message || error}`;
      }
    }
  });
  loadMore.addEventListener("click", () => fetchServers(false));
  serverSort.addEventListener("change", () => {
    try {
      localStorage.setItem(SERVER_SORT_KEY, serverSort.value);
    } catch (error) {
      status.textContent = `Couldn't remember server sort: ${error?.message || error}`;
    }
    fetchServers(true);
  });
  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.page === "friends") loadFriends();
      else if (button.dataset.page === "discover") loadDiscover();
      else if (button.dataset.page === "saved") loadSaved();
      else loadHome();
    });
  });
  home.querySelector(".sidebar-shortcut").addEventListener("click", async () => {
    if (page !== "home") await loadHome();
    feed.querySelector("#continue")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  accountButton.addEventListener("click", () => {
    accountMenuStatus.textContent = "";
    renderAccountMenu();
    toggleAccountMenu();
  });
  addAccountButton.addEventListener("click", async () => {
    current += 1;
    profileRequest += 1;
    const previousSession = savedSession();
    const previousManual = localStorage.getItem(MANUAL_KEY) === "1";
    const wasSignedIn = sessionAvailable;
    try {
      accountMenuStatus.textContent = "Sign in to the account you want to add…";
      await askForSession(previousSession !== null, { clearRobloxCookies: wasSignedIn });
      resetAccountRequests();
      sessionAvailable = true;
      localStorage.removeItem(LOGGED_OUT_KEY);
      await saveActiveAccount();
      accountMenuStatus.textContent = "";
      toggleAccountMenu(false);
      void refreshBalance();
      await loadHome({ syncSession: false });
    } catch (error) {
      if (previousSession) storeSession(previousSession, previousManual);
      else forgetSession();
      resetAccountRequests();
      sessionAvailable = wasSignedIn;
      if (!wasSignedIn) localStorage.setItem(LOGGED_OUT_KEY, "1");
      accountMenuStatus.textContent = `Couldn't add account: ${error?.message || error}`;
      renderAccountMenu();
    }
  });
  logoutButton.addEventListener("click", async () => {
    try {
      const currentSession = savedSession();
      writeAccounts(readAccounts().filter((account) =>
        account.id !== activeAccountId && account.session !== currentSession,
      ));
      forgetSession();
      localStorage.removeItem(MANUAL_KEY);
      localStorage.setItem(LOGGED_OUT_KEY, "1");
      resetAccountRequests();
      sessionAvailable = false;
      activeAccountId = null;
      activeAccountName = "";
      currencyBalance.hidden = true;
      currencyValue.textContent = "";
      setAccountButtonLabel("Sign in");
      toggleAccountMenu(false);
      renderAccountMenu();
      await loadHome({ syncSession: false });
    } catch (error) {
      accountMenuStatus.textContent = `Couldn't log out: ${error?.message || error}`;
    }
  });
  themeSelect.addEventListener("change", () => {
    if (!THEMES.has(themeSelect.value)) return;
    home.dataset.theme = themeSelect.value;
    try {
      localStorage.setItem(THEME_KEY, themeSelect.value);
      accountMenuStatus.textContent = "";
    } catch (error) {
      accountMenuStatus.textContent = `Theme changed for this session, but couldn't save it: ${error?.message || error}`;
    }
  });
  document.addEventListener("click", (event) => {
    if (!home.querySelector(".account-controls").contains(event.target)) toggleAccountMenu(false);
  });
  renderAccountMenu();

  let autocompleteTimer = null;
  let autocompleteRequest = 0;

  function hideSuggestions() {
    suggestions.hidden = true;
    suggestions.replaceChildren();
    input.setAttribute("aria-expanded", "false");
  }

  function showSuggestionMessage(text) {
    const message = document.createElement("p");
    message.className = "search-suggestion-message";
    message.setAttribute("role", "status");
    message.textContent = text;
    suggestions.replaceChildren(message);
    suggestions.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function renderSuggestions(entries) {
    suggestions.replaceChildren();
    const results = entries
      .map((entry) => {
        if (typeof entry === "string") return { label: entry, thumbnail: "", game: null, type: "Recent search" };
        if (entry?.clearHistory) return { label: "Clear recent searches", thumbnail: "", game: null, type: "Action", clearHistory: true };
        if (!entry || !/^[1-9]\d{0,18}$/.test(String(entry.placeId))) return null;
        return {
          label: entry.name || `Experience ${entry.placeId}`,
          thumbnail: entry.thumb || "",
          game: entry,
          type: entry.creator || "Experience",
        };
      })
      .filter(Boolean)
      .slice(0, 10);
    if (!results.length) {
      hideSuggestions();
      return;
    }

    for (const [index, result] of results.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "search-suggestion";
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      const image = result.thumbnail ? document.createElement("img") : null;
      if (image) {
        image.src = result.thumbnail;
        image.alt = "";
      }
      const label = document.createElement("span");
      label.className = "search-suggestion-label";
      label.textContent = result.label;
      const type = document.createElement("span");
      type.className = "search-suggestion-type";
      type.append(faIcon(result.game ? "gamepad" : "clock-rotate-left"));
      type.append(document.createTextNode(result.type));
      if (image) option.append(image);
      option.append(label, type);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        hideSuggestions();
        if (result.clearHistory) {
          clearSearchHistory();
          return;
        }
        input.value = result.label;
        clearSearchButton.hidden = !input.value;
        if (result.game) showGameDetails(result.game);
        else form.requestSubmit();
      });
      option.addEventListener("keydown", (event) => {
        const options = [...suggestions.querySelectorAll(".search-suggestion")];
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = index + (event.key === "ArrowDown" ? 1 : -1);
          if (options[next]) options[next].focus();
          else if (event.key === "ArrowUp" && index === 0) input.focus();
          else if (event.key === "ArrowDown" && index === options.length - 1) options[0].focus();
        } else if (event.key === "Home") {
          event.preventDefault();
          options[0]?.focus();
        } else if (event.key === "End") {
          event.preventDefault();
          options.at(-1)?.focus();
        } else if (event.key === "Escape") {
          hideSuggestions();
          input.focus();
        }
      });
      suggestions.append(option);
    }
    suggestions.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  async function loadSuggestions(query, request) {
    try {
      const games = await searchGames(query, 10);
      if (request !== autocompleteRequest || input.value.trim() !== query) return;
      renderSuggestions(games);
    } catch (error) {
      if (request === autocompleteRequest && input.value.trim() === query) {
        showSuggestionMessage(`Suggestions unavailable: ${error?.message || error}`);
      }
    }
  }

  input.addEventListener("input", () => {
    if (autocompleteTimer !== null) clearTimeout(autocompleteTimer);
    const query = input.value.trim();
    const request = ++autocompleteRequest;
    clearSearchButton.hidden = !query;
    hideSuggestions();
    if (!query || placeFromInput(query)) return;
    autocompleteTimer = setTimeout(() => loadSuggestions(query, request), 180);
  });
  input.addEventListener("focus", () => {
    if (!input.value.trim()) {
      const history = readSearchHistory();
      if (history.length) renderSuggestions([...history, { clearHistory: true }]);
    }
  });
  clearSearchButton.addEventListener("click", () => {
    input.value = "";
    clearSearchButton.hidden = true;
    input.focus();
    hideSuggestions();
    const history = readSearchHistory();
    if (history.length) renderSuggestions([...history, { clearHistory: true }]);
  });
  input.addEventListener("keydown", (event) => {
    if (suggestions.hidden) return;
    const options = suggestions.querySelectorAll(".search-suggestion");
    if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      options[0].focus();
    } else if (event.key === "ArrowUp" && options.length) {
      event.preventDefault();
      options[options.length - 1].focus();
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!form.contains(event.target)) hideSuggestions();
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea, select"));
    if (typing || dialog.open || userDialog.open) return;
    if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });

  function resultsHead(query) {
    const head = document.createElement("div");
    head.className = "results-head";
    const heading = document.createElement("h2");
    heading.append(faIcon("magnifying-glass"), document.createTextNode(`Results for “${query}”`));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "clear";
    setIconLabel(clear, "xmark", "Clear search");
    clear.addEventListener("click", () => {
      input.value = "";
      input.focus();
      loadHome();
    });
    head.append(heading, clear);
    return head;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (autocompleteTimer !== null) clearTimeout(autocompleteTimer);
    autocompleteRequest += 1;
    hideSuggestions();
    const place = placeFromInput(input.value);
    // Recorded with the place id alone; Continue fills in its name and art.
    if (place) return play(place, { placeId: place });
    page = "home";
    navButtons.forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const query = input.value.trim();
    if (!query) return loadHome();
    rememberSearch(query);
    const ticket = ++current;
    status.textContent = "Searching…";
    feed.replaceChildren();
    try {
      const games = await searchGames(query);
      if (ticket !== current) return;
      if (!games.length) {
        feed.replaceChildren(resultsHead(query));
        status.textContent = "No games found.";
        return;
      }
      status.textContent = "";
      feed.replaceChildren(resultsHead(query), gameSection(null, games, { grid: true, onSelect: showGameDetails }));
    } catch (error) {
      if (ticket === current) status.textContent = `Search failed: ${error.message || error}`;
    }
  });
  input.focus();
  loadHome();
}

// ---- Boot ---------------------------------------------------------------------

async function controlled() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser has no service worker support.");
  await navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  // First visit: the worker claims this page once it activates.
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  if (!navigator.serviceWorker.controller) throw new Error("The service worker did not take control of this page. Reload to try again.");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.append(script);
  });
}

function returnToLauncherOnGameExit() {
  const redirectError = new Error("The game closed; returning to the launcher.");
  redirectError.name = "BloxExitRedirect";
  window.addEventListener("error", (event) => {
    if (event.error === redirectError || event.error?.name === redirectError.name) {
      event.preventDefault();
    }
  });
  window.close = () => {
    location.replace(ROOT.href);
    throw redirectError;
  };
}

async function boot() {
  if (!window.crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the engine cannot use shared memory. Go to https://rblx.chedar.dev/ to open the full version.");
  }
  say("Connecting…");
  await controlled();
  await transport;
  const placeId = new URLSearchParams(location.search).get("placeId");
  // The engine only joins experiences: without a place it logs "no startup
  // place id" and exits, so pick one here first.
  if (!placeId || !/^[1-9]\d{0,18}$/.test(placeId)) return showLauncher();
  say("Checking your Roblox session…");
  await ensureSession();
  returnToLauncherOnGameExit();
  say("Starting…");
  // What Roblox's WasmLoader.js leaves behind for WasmPlayer.js. channel null
  // keeps the engine on the production flags and channel.
  window.__wasmLoaderContext = { engineBase: ENGINE_BASE, channel: null, server: "prod" };
  await loadScript(`${ENGINE_BASE}/WasmPlayer.js`);
}

boot().catch((error) => {
  console.error("[blox]", error);
  say(error.message || String(error));
});
