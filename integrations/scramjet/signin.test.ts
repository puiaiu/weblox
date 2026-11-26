import { expect, it } from "bun:test";
import { proxiedUrl } from "./signin";

const controller = { config: { codec: { encode: (url: string) => encodeURIComponent(url) } } };
const base = "https://proxy.test/blox/";
const LOGIN = "https://www.roblox.com/login";
const PROXIED = "https://proxy.test/~/sj/ab12cd34/f1/https%3A%2F%2Fwww.roblox.com%2Flogin";

function frame(navigates = true) {
  const element = { src: "" };
  return {
    prefix: "/~/sj/ab12cd34/f1/",
    element,
    go(url: string) {
      if (navigates) element.src = `https://proxy.test${this.prefix}${encodeURIComponent(url)}`;
    },
  };
}

it("takes the proxied URL the frame navigated to", () => {
  expect(proxiedUrl(controller, frame(), LOGIN, base)).toBe(PROXIED);
  expect(proxiedUrl(controller, frame(), LOGIN, new URL(base))).toBe(PROXIED);
});

it("builds the proxied URL from the frame prefix when go() set none", () => {
  expect(proxiedUrl(controller, frame(false), LOGIN, base)).toBe(PROXIED);
});

it("falls back to what the frame rewrote when the controller has no codec", () => {
  expect(proxiedUrl({}, frame(), LOGIN, base)).toBe(PROXIED);
});

it("refuses a frame that is not proxied onto the player page's origin", () => {
  const prefixElsewhere = { prefix: "https://elsewhere.test/~/sj/ab12cd34/f1/", element: { src: "" }, go() {} };
  expect(proxiedUrl(controller, prefixElsewhere, LOGIN, base)).toBeNull();
  const rewroteElsewhere = frame(false);
  rewroteElsewhere.element.src = "https://elsewhere.test/~/sj/ab12cd34/f1/x";
  expect(proxiedUrl({}, rewroteElsewhere, LOGIN, base)).toBeNull();
  expect(proxiedUrl({}, frame(false), LOGIN, base)).toBeNull();
  expect(proxiedUrl(controller, frame(false), LOGIN, "not a url")).toBeNull();
});
