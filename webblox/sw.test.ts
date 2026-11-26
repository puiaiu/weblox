import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";

type FetchEventLike = {
  request: { url: string };
  clientId: string;
  respondWith: (response: Promise<Response>) => void;
};

test("lets the Font Awesome CDN load directly while relaying Roblox requests", async () => {
  const listeners = new Map<string, (event: FetchEventLike) => void>();
  const self = {
    registration: { scope: "https://example.test/blox/" },
    location: { origin: "https://example.test" },
    addEventListener: (type: string, listener: (event: FetchEventLike) => void) => listeners.set(type, listener),
  };
  const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, URL, Set, Promise, Response, Headers });
  const handleFetch = listeners.get("fetch");
  expect(handleFetch).toBeDefined();

  const dispatch = (url: string) => {
    let response: Promise<Response> | undefined;
    handleFetch?.({ request: { url }, clientId: "", respondWith: (value) => (response = value) });
    return response;
  };

  expect(dispatch("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css")).toBeUndefined();
  const relayed = dispatch("https://www.roblox.com/v1/users/authenticated");
  expect(relayed).toBeDefined();
  expect(await relayed).toBeInstanceOf(Response);
});
