import EpoxyTransport from "@mercuryworkshop/epoxy-transport";
import { defaultConfig } from "@mercuryworkshop/scramjet";
import { config as controllerConfig, Controller } from "@mercuryworkshop/scramjet-controller";
import { installBloxSignIn } from "../integrations/scramjet/signin";

const PREFIX = "/proxy/";
const LOGIN_URL = "https://www.roblox.com/login";
const ALLOWED_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com|arkoselabs\.com|funcaptcha\.com)$/i;
const address = document.getElementById("address") as HTMLInputElement;
const form = document.getElementById("address-form") as HTMLFormElement;
const frameElement = document.getElementById("browser") as HTMLIFrameElement;
const status = document.getElementById("status")!;

function wispUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/wisp/`;
}

async function clearRobloxCookies(controller: Controller): Promise<void> {
  let cookies: Record<string, { name?: unknown; domain?: unknown; path?: unknown; hostOnly?: unknown }>;
  try {
    cookies = JSON.parse(controller.cookieJar.dump());
  } catch {
    throw new Error("Sign-in browser cookies could not be read.");
  }
  for (const cookie of Object.values(cookies)) {
    if (typeof cookie?.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) continue;
    if (typeof cookie.domain !== "string") continue;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (!/(^|\.)roblox\.com$/.test(domain)) continue;
    const path = typeof cookie.path === "string" && cookie.path.startsWith("/") && !/[;\r\n]/.test(cookie.path)
      ? cookie.path
      : "/";
    const domainAttribute = cookie.hostOnly === true ? "" : `; Domain=${domain}`;
    controller.cookieJar.setCookies(
      `${cookie.name}=; Max-Age=0; Path=${path}${domainAttribute}`,
      new URL(`https://${domain}/`),
    );
  }
  await controller.persistCookies();
}

function normalizeTarget(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a website URL.");
  const target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!ALLOWED_HOST.test(target.hostname)) {
    throw new Error("This sign-in browser is limited to supported sign-in and CAPTCHA domains.");
  }
  return target.href;
}

function waitForServiceWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error("The proxy service worker did not start."));
  if (worker.state === "activated") return Promise.resolve(worker);

  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve(worker);
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("The proxy service worker failed to activate."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

async function start(): Promise<void> {
  const registration = await navigator.serviceWorker.register(`${PREFIX}sw.js`, { scope: PREFIX });
  const serviceworker = await waitForServiceWorker(registration);

  const controller = new Controller({
    serviceworker,
    transport: new EpoxyTransport({ wisp: wispUrl() }),
    config: {
      ...controllerConfig,
      prefix: `${PREFIX}~/sj/`,
      scramjetPath: `${PREFIX}scramjet/scramjet.js`,
      injectPath: `${PREFIX}controller/controller.inject.js`,
      wasmPath: `${PREFIX}scramjet/scramjet.wasm`,
    },
    scramjetConfig: defaultConfig,
  });
  await controller.wait();
  const pageUrl = new URL(location.href);
  if (pageUrl.searchParams.get("clearRobloxCookies") === "1") {
    await clearRobloxCookies(controller);
    pageUrl.searchParams.delete("clearRobloxCookies");
    history.replaceState(history.state, "", pageUrl);
  }
  installBloxSignIn(controller, { base: location.href });

  const requested = pageUrl.searchParams.get("login") || LOGIN_URL;
  address.value = normalizeTarget(requested);
  const frame = controller.createFrame(frameElement);
  frameElement.addEventListener("load", () => {
    status.textContent = "Sign-in browser is ready.";
  });
  frameElement.addEventListener("error", () => {
    status.textContent = "Couldn't load the sign-in page.";
  });
  frame.go(address.value);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      address.value = normalizeTarget(address.value);
      frame.go(address.value);
      status.textContent = "Sign-in browser is ready.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  status.textContent = "Sign-in browser is ready.";
}

start().catch((error: unknown) => {
  console.error("[blox] Scramjet sign-in browser failed:", error);
  status.textContent = `Couldn't start the sign-in browser: ${error instanceof Error ? error.message : String(error)}`;
});
