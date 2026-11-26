import { beforeEach, expect, it, mock } from "bun:test";
import type { BloxLaunch } from "./launch";
import { answerSignIn, createBloxLaunchPlugin, signInUrl } from "./plugin";

type Handler = (...args: unknown[]) => void;

const PROTOCOL = `roblox-player:1+launchmode:play+gameinfo:abc+placelauncherurl:${encodeURIComponent(
  "https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=77",
)}`;

let taps: Map<unknown, Handler>;
let opened: BloxLaunch[];

class FakeBase {
  constructor(readonly name: string, readonly dependencies: string[]) {}
  install(): void {}
  tap(hook: unknown, handler: Handler): void {
    taps.set(hook, handler);
  }
}

// The parts of a proxied window the plugin touches.
const win = {
  addEventListener() {},
  fetch,
  Element: class {},
  HTMLIFrameElement: class {},
};

// The parts of a Scramjet frame client the plugin uses.
function hookedPage() {
  const proxies: Record<string, { apply(context: unknown): void }> = {};
  const traps: { set(context: unknown, value: unknown): void }[] = [];
  const client = {
    meta: { base: new URL("https://www.roblox.com/games/77") },
    unrewriteUrl: (url: string) => url,
    rewriteUrl: (url: string | URL) => `/~/sj/abc/f1/${encodeURIComponent(String(url))}`,
    Proxy: (path: string, handlers: { apply(context: unknown): void }) => void (proxies[path] = handlers),
    RawTrap: (_target: unknown, _property: string, handlers: { set(context: unknown, value: unknown): void }) => void traps.push(handlers),
  };
  taps.get("init.post")!({ client, window: win });
  return { proxies, iframeSrc: traps[0]! };
}

function applyContext(...args: unknown[]) {
  const state = { returned: false, value: undefined as unknown };
  return { args, this: undefined, return: (value: unknown) => Object.assign(state, { returned: true, value }), state };
}

beforeEach(() => {
  taps = new Map();
  opened = [];
  const plugin = createBloxLaunchPlugin(FakeBase as never, {
    url: (launch) => JSON.stringify(launch),
    open: (url) => {
      opened.push(JSON.parse(url));
      return {} as Window;
    },
    notify: () => {},
  });
  plugin.install({ hooks: { init: { post: "init.post" }, fetch: { intercept: "fetch.intercept" } } });
});

it("opens /blox/ on the place instead of loading a roblox-player iframe", () => {
  const { iframeSrc } = hookedPage();
  const set = mock();
  iframeSrc.set({ set }, PROTOCOL);
  expect(set).not.toHaveBeenCalled();
  expect(opened).toEqual([{ placeId: "77" }]);
});

it("leaves every other iframe alone", () => {
  const { iframeSrc } = hookedPage();
  const set = mock();
  iframeSrc.set({ set }, "https://www.roblox.com/embed");
  expect(set).toHaveBeenCalledWith("https://www.roblox.com/embed");
  expect(opened).toEqual([]);
});

it("turns window.open of /games/start into /blox/ with the server", () => {
  const { proxies } = hookedPage();
  const context = applyContext("https://www.roblox.com/games/start?placeId=5&gameInstanceId=aa-bb", "_blank");
  proxies["window.open"]!.apply(context);
  expect(context.state).toEqual({ returned: true, value: null });
  expect(opened).toEqual([{ placeId: "5", serverId: "aa-bb" }]);
});

it("names the proxy's own roblox.com/login page for /blox/'s sign-in prompt", () => {
  const rewrite = { rewriteUrl: (url: string | URL) => `/~/sj/abc/f1/${encodeURIComponent(String(url))}` };
  expect(signInUrl(rewrite, "https://proxy.test/app/")).toBe(
    `https://proxy.test/~/sj/abc/f1/${encodeURIComponent("https://www.roblox.com/login")}`,
  );
});

it("answers /blox/'s sign-in request over the proxy channel", async () => {
  const page = "https://proxy.test/app/";
  const stop = answerSignIn({ rewriteUrl: (url) => `/~/sj/abc/f1/${encodeURIComponent(String(url))}` }, page);
  const id = crypto.randomUUID();
  const reply = await new Promise<{ type?: string; id?: string; url?: string } | null>((resolve) => {
    const channel = new BroadcastChannel("blox-signin");
    const timer = setTimeout(() => {
      channel.close();
      resolve(null);
    }, 1000);
    channel.onmessage = (event) => {
      if (event.data?.id !== id) return;
      clearTimeout(timer);
      channel.close();
      resolve(event.data);
    };
    channel.postMessage({ type: "blox-signin-request", id, origin: "https://proxy.test" });
  });
  stop();
  expect(reply?.type).toBe("blox-signin-opened");
  expect(reply?.url).toBe(`https://proxy.test/~/sj/abc/f1/${encodeURIComponent("https://www.roblox.com/login")}`);
});

it("anchors the sign-in page on the proxy, not on the proxied site's origin", () => {
  const client = {
    context: { prefix: new URL("https://proxy.test/~/sj/abc/f1/") },
    rewriteUrl: (url: string | URL) => `/~/sj/abc/f1/${encodeURIComponent(String(url))}`,
  };
  // Inside a proxied document location.href is roblox.com's, so no page is given.
  expect(signInUrl(client)).toBe(`https://proxy.test/~/sj/abc/f1/${encodeURIComponent("https://www.roblox.com/login")}`);
});

it("refuses a sign-in page that is not on the player page's origin", () => {
  const base = "https://proxy.test/app/";
  expect(signInUrl({ rewriteUrl: () => "https://elsewhere.test/x" }, base)).toBeNull();
  expect(
    signInUrl(
      {
        rewriteUrl: () => {
          throw new Error("no rewriter");
        },
      },
      base,
    ),
  ).toBeNull();
});

it("answers a navigation to /games/start in the tab with a launching page", () => {
  const result: { response?: { body: string; status: number } } = {};
  const Headers = { fromRawHeaders: (raw: [string, string][]) => raw };
  taps.get("fetch.intercept")!(
    {
      parsed: { isIframe: false, destination: "document", url: new URL("https://www.roblox.com/games/start?placeId=9") },
      request: { initialHeaders: { constructor: Headers } },
    },
    result,
  );
  expect(result.response?.status).toBe(200);
  expect(result.response?.body).toContain("new window");
  expect(opened).toEqual([{ placeId: "9" }]);
});

it("builds the sign-in page from the frame prefix when the client cannot rewrite", () => {
  const client = {
    context: {
      prefix: new URL("https://proxy.test/~/sj/abc/f1/"),
      interface: { codecEncode: (url: string) => encodeURIComponent(url) },
    },
  };
  expect(signInUrl(client)).toBe(`https://proxy.test/~/sj/abc/f1/${encodeURIComponent("https://www.roblox.com/login")}`);
});
