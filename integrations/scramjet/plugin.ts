// Playing Roblox from roblox.com inside a Scramjet 2 proxy: a frame plugin
// catches the site's attempts to start the desktop app and opens /blox/ (the
// web client) on that place instead.
//
// roblox.com launches in one of these ways, all covered here:
// - a protocol uri (roblox-player:…, roblox://…) set as a hidden iframe's src,
//   opened with window.open, or as a link's href;
// - window.open, a link, or a top-level navigation to /games/start?placeId=….
//
// Usage, where the Scramjet controller's plugins are set up:
//   createBloxLaunchPlugin(plugins.ManagedPlugin, {
//     url: (launch) => bloxUrl("/blox/", launch, "wss://example.com/wisp/"),
//   })
import {
  FollowError,
  isProtocolUri,
  lookupFollow,
  parseFollowUri,
  parseGamesStart,
  parseLaunchUri,
  type BloxFollow,
  type BloxLaunch,
  type Fetcher,
} from "./launch";

const SELF_TARGETS = ["_self", "_parent", "_top", "_unfencedtop"];
// /blox/'s sign-in prompt asks any page of this proxy on the same origin for a
// proxied roblox.com/login url (see answerSignIn below).
const SIGNIN_CHANNEL = "blox-signin";
const SIGNIN_PAGE = "https://www.roblox.com/login";
// Shown in the frame in place of /games/start while the game opens beside it.
const LAUNCHING_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Launching</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:Canvas;color:CanvasText">Roblox is opening in a new window…';

const MESSAGES = {
  "popup-blocked": "Allow pop-ups for this site, then press Play again.",
  "not-playing": "Your friend isn't in a game you can join.",
  unreachable: "Couldn't reach Roblox to find your friend.",
  unsupported: "This kind of Roblox launch isn't supported here.",
} as const;

type ApplyContext = { args: unknown[]; this: unknown; return(value: unknown): void };
type SetContext = { set(value: unknown): void };
type ProxiedWindow = Window & typeof globalThis;
type ScramjetClient = {
  meta: { base: URL };
  unrewriteUrl(url: string): string;
  rewriteUrl(url: string | URL, options?: unknown): string;
  Proxy(path: string, handlers: { apply(context: ApplyContext): void }): void;
  RawTrap(target: object, property: string, handlers: { set(context: SetContext, value: unknown): void }): void;
};
type InitContext = { client: ScramjetClient; window: ProxiedWindow };
type FetchContext = {
  parsed: { isIframe: boolean; destination: string; url: URL };
  request: { initialHeaders: { constructor: { fromRawHeaders(raw: [string, string][]): unknown } } };
};
type FetchResult = { response?: { body: string; headers: unknown; status: number; statusText: string } };
type PluginHost = { hooks: { init: { post: unknown }; fetch: { intercept: unknown } } };
type PluginBase = { install(host: PluginHost): void; tap(hook: unknown, handler: (...args: never[]) => void): void };
export type ManagedPluginClass = new (name: string, dependencies: string[]) => PluginBase;

export type BloxLaunchOptions = {
  /** The page to open for a launch, usually bloxUrl(…). */
  url(launch: BloxLaunch): string;
  /** Opens a new window on `url`. Defaults to a popup most of the screen, as the desktop app would be. */
  open?(url: string): Window | null;
  /** Tells the user why nothing opened. Defaults to window.alert. */
  notify?(message: string): void;
};

/**
 * /blox/ joining `launch`: `base` is where the host page is served (relative to
 * this page or absolute), `wisp` the Wisp server it should use (the page falls
 * back to /wisp/ on its own host).
 */
export function bloxUrl(base: string | URL, launch: BloxLaunch, wisp?: string): string {
  const url = new URL(base, location.href);
  url.searchParams.set("placeId", launch.placeId);
  if (launch.serverId) url.searchParams.set("gameInstanceId", launch.serverId);
  if (wisp) url.searchParams.set("wisp", wisp);
  return url.href;
}

type SignInRewriter = {
  rewriteUrl?(url: string | URL, options?: unknown): string;
  context?: { prefix?: string | URL; interface?: { codecEncode?(input: string): string } };
};

// Inside a proxied document, location is the proxied site's own address, so the
// controller's frame prefix is what says where this proxy lives.
function signInBase(client: SignInRewriter): string {
  const prefix = client.context?.prefix;
  return prefix ? String(prefix) : globalThis.location?.href ?? "http://localhost/";
}

/** The proxy's URL for roblox.com/login on the proxy's origin, or null. */
export function signInUrl(client: SignInRewriter, page: string | URL = signInBase(client)): string | null {
  let rewritten = "";
  try {
    rewritten = typeof client.rewriteUrl === "function" ? client.rewriteUrl(SIGNIN_PAGE) : "";
  } catch {
    rewritten = "";
  }
  if (!rewritten) {
    // Older clients: the frame prefix and the codec the controller gave them.
    const encode = client.context?.interface?.codecEncode;
    const prefix = client.context?.prefix;
    if (typeof encode !== "function" || !prefix) return null;
    try {
      rewritten = String(prefix) + encode(SIGNIN_PAGE);
    } catch {
      return null;
    }
  }
  if (!rewritten) return null;
  let proxied: URL;
  try {
    proxied = new URL(rewritten, page);
  } catch {
    return null;
  }
  return proxied.origin === new URL(page).origin ? proxied.href : null;
}

// /blox/ cannot encode a proxied URL by itself, so it asks the pages of this
// proxy on its origin. The answer opens roblox.com/login in a window of its
// own; the session Roblox sets there goes into the controller's cookie jar,
// which /blox/ then reads. Returns a function that stops answering.
export function answerSignIn(client: SignInRewriter, page: string | URL = signInBase(client)): () => void {
  if (typeof BroadcastChannel !== "function") return () => {};
  const origin = new URL(page).origin;
  const channel = new BroadcastChannel(SIGNIN_CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as { type?: unknown; id?: unknown; origin?: unknown } | null;
    if (!message || message.type !== "blox-signin-request" || typeof message.id !== "string") return;
    // Only answer for the player page on this proxy, never for another origin.
    if (message.origin !== origin) return;
    const url = signInUrl(client, page);
    channel.postMessage(url ? { type: "blox-signin-opened", id: message.id, url } : { type: "blox-signin-failed", id: message.id });
  };
  return () => channel.close();
}

function popupFeatures(): string {
  const width = Math.round(screen.availWidth * 0.95);
  const height = Math.round(screen.availHeight * 0.9);
  const left = Math.round((screen.availWidth - width) / 2);
  const top = Math.round((screen.availHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

export function createBloxLaunchPlugin(ManagedPlugin: ManagedPluginClass, options: BloxLaunchOptions): PluginBase {
  const open = options.open ?? ((url: string) => window.open(url, "_blank", popupFeatures()));
  const notify = options.notify ?? ((message: string) => window.alert(message));

  // Called from the click that pressed Play, so pop-ups are allowed.
  function openBlox(launch: BloxLaunch): void {
    if (!open(options.url(launch))) notify(MESSAGES["popup-blocked"]);
  }

  // The presence lookup is a network round trip, longer than a click keeps its
  // permission to open windows: open the window first, point it at the game after.
  async function openFollow(fetcher: Fetcher, follow: BloxFollow): Promise<void> {
    const popup = open("about:blank");
    if (!popup) {
      notify(MESSAGES["popup-blocked"]);
      return;
    }
    try {
      popup.location.replace(options.url(await lookupFollow(fetcher, follow)));
    } catch (error) {
      popup.close();
      notify(MESSAGES[error instanceof FollowError ? error.reason : "unreachable"]);
    }
  }

  // True when `value` was a Roblox protocol uri, launched or not: the page must
  // never try to open it itself.
  function handleProtocol(win: ProxiedWindow, value: unknown): boolean {
    if (typeof value !== "string" || !isProtocolUri(value)) return false;
    const launch = parseLaunchUri(value);
    if (launch) {
      openBlox(launch);
      return true;
    }
    const follow = parseFollowUri(value);
    if (follow) void openFollow(win.fetch.bind(win), follow);
    else notify(MESSAGES.unsupported);
    return true;
  }

  // A /games/start link in the page may be written as the real url or already
  // rewritten to the proxy's.
  function resolveGamesStart(client: ScramjetClient, raw: string): BloxLaunch | null {
    let absolute: string;
    try {
      absolute = new URL(raw, client.meta.base.href).href;
    } catch {
      return null;
    }
    const direct = parseGamesStart(absolute);
    if (direct) return direct;
    try {
      const original = client.unrewriteUrl(absolute);
      return original === absolute ? null : parseGamesStart(original);
    } catch {
      return null;
    }
  }

  function hookWindow({ client, window: win }: InitContext): void {
    answerSignIn(client);
    client.Proxy("window.open", {
      apply(context) {
        const target = context.args[1] == null ? "_blank" : String(context.args[1]).toLowerCase();
        if (SELF_TARGETS.includes(target) && context.args[0] == null) return;
        const raw = context.args[0] == null ? "" : String(context.args[0]);
        if (handleProtocol(win, raw)) {
          context.return(null);
          return;
        }
        const launch = raw ? resolveGamesStart(client, raw) : null;
        if (!launch) return;
        context.return(null);
        openBlox(launch);
      },
    });
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
      const anchor = event
        .composedPath()
        .find((node): node is HTMLAnchorElement => node instanceof win.Element && node.matches("a[href], area[href]"));
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (handleProtocol(win, href)) {
        event.preventDefault();
        return;
      }
      const launch = resolveGamesStart(client, href) ?? resolveGamesStart(client, anchor.href);
      if (!launch) return;
      event.preventDefault();
      openBlox(launch);
    };
    win.addEventListener("click", onClick);
    win.addEventListener("auxclick", onClick);
    client.RawTrap(win.HTMLIFrameElement.prototype, "src", {
      set(context, value) {
        if (!handleProtocol(win, value)) context.set(value);
      },
    });
    client.Proxy("Element.prototype.setAttribute", {
      apply(context) {
        const [name, value] = context.args;
        if (typeof name !== "string" || name.toLowerCase() !== "src") return;
        if (typeof value !== "string" || !isProtocolUri(value)) return;
        if (!(context.this instanceof win.HTMLIFrameElement)) return;
        if (handleProtocol(win, value)) context.return(undefined);
      },
    });
  }

  // Accounts on Roblox's web client are sent to /games/start instead of a protocol uri.
  function interceptNavigation(context: FetchContext, result: FetchResult): void {
    const { parsed } = context;
    if (parsed.isIframe) return;
    if (parsed.destination !== "document" && parsed.destination !== "iframe") return;
    const launch = parseGamesStart(parsed.url.href);
    if (!launch) return;
    const Headers = context.request.initialHeaders.constructor;
    result.response = {
      body: LAUNCHING_PAGE,
      headers: Headers.fromRawHeaders([
        ["content-type", "text/html; charset=utf-8"],
        ["cache-control", "no-store"],
      ]),
      status: 200,
      statusText: "OK",
    };
    openBlox(launch);
  }

  class BloxLaunchPlugin extends ManagedPlugin {
    constructor() {
      super("webblox-launch", []);
    }

    install(host: PluginHost): void {
      super.install(host);
      this.tap(host.hooks.init.post, hookWindow);
      this.tap(host.hooks.fetch.intercept, interceptNavigation);
    }
  }
  return new BloxLaunchPlugin();
}
