// "Sign in with Roblox" on /blox/.
//
// The player page cannot open a proxied roblox.com by itself: only the site's
// own Scramjet 2 controller can make a frame that its service worker will
// serve. So the player page broadcasts a request on the "blox-signin" channel,
// and this module, running where that controller lives, answers with a proxied
// roblox.com/login URL in a fresh frame of the controller. The player page
// opens it in the window its click made room for. Every cookie Roblox sets in
// that frame goes into the controller's cookie jar (IndexedDB, same origin), so
// the player page then takes the .ROBLOSECURITY session from there: no devtools
// and no copying.
//
// Usage, once the controller is ready:
//   import { installBloxSignIn } from "./integrations/scramjet/signin";
//   await controller.wait();
//   installBloxSignIn(controller);

const CHANNEL = "blox-signin";
const LOGIN_URL = "https://www.roblox.com/login";

/** The parts of a Scramjet 2 Frame this module uses. */
export type BloxSignInFrame = {
  prefix: string;
  element: { src: string };
  go(url: string): void;
};

/** The parts of a Scramjet 2 Controller this module uses. */
export type BloxSignInController = {
  config?: { codec?: { encode?(url: string): string } };
  createFrame(): BloxSignInFrame;
};

export type BloxSignInOptions = {
  /** Where the player page is served; the login frame must be proxied onto its origin. */
  base?: string | URL;
  /** The page to sign in on. Roblox's login page by default. */
  url?: string;
};

/**
 * The proxied URL of `url` in `frame`, or null when the frame is not proxied
 * onto `base`'s origin (its service worker would not serve it).
 */
export function proxiedUrl(
  controller: Pick<BloxSignInController, "config">,
  frame: BloxSignInFrame,
  url: string,
  base: string | URL,
): string | null {
  // The controller's own codec, over the frame's prefix: the URL it would make
  // for go(url) without the request metadata a navigation carries.
  const encode = controller.config?.codec?.encode;
  let target = "";
  if (typeof frame.prefix === "string" && frame.prefix && typeof encode === "function") {
    try {
      target = frame.prefix + encode(url);
    } catch {
      target = "";
    }
  }
  if (!target) {
    // No codec to ask: take what the frame rewrote the page to.
    try {
      frame.go(url);
      target = typeof frame.element?.src === "string" ? frame.element.src : "";
    } catch {
      target = "";
    }
  }
  if (!target) return null;
  let proxied: URL;
  try {
    proxied = new URL(target, base);
    if (proxied.origin !== new URL(base).origin) return null;
  } catch {
    return null;
  }
  return proxied.href;
}

/**
 * Answers /blox/'s sign-in requests from this page. Returns a function that
 * stops listening.
 */
export function installBloxSignIn(controller: BloxSignInController, options: BloxSignInOptions = {}): () => void {
  const Channel = globalThis.BroadcastChannel;
  if (typeof Channel !== "function") return () => {};
  const base = options.base ?? globalThis.location?.href ?? "http://localhost/";
  const login = options.url ?? LOGIN_URL;
  const channel = new Channel(CHANNEL);
  const origin = new URL(base).origin;
  channel.onmessage = ({ data }: MessageEvent) => {
    const message = data as { type?: unknown; id?: unknown; origin?: unknown } | null;
    if (!message || typeof message !== "object" || message.type !== "blox-signin-request" || typeof message.id !== "string") return;
    // Only answer for the player page this controller shares an origin with.
    if (message.origin !== origin) return;
    let url: string | null = null;
    try {
      const frame = controller.createFrame();
      // Also registers the frame's prefix with the service worker.
      try {
        frame.go(login);
      } catch {
        // A frame that cannot navigate still has a prefix worth answering with.
      }
      url = proxiedUrl(controller, frame, login, base);
    } catch {
      url = null;
    }
    channel.postMessage(url ? { type: "blox-signin-opened", id: message.id, url } : { type: "blox-signin-failed", id: message.id });
  };
  return () => channel.close();
}
