import { describe, expect, test } from "bun:test";
import { createProxyHandler, PROXY_LOGIN_PATH } from "./proxy";

const handleProxy = createProxyHandler(new ArrayBuffer(0));

describe("Scramjet sign-in entry point", () => {
  test("serves the proxy app at /logon without a login URL query", async () => {
    const request = new Request(`http://webblox.test${PROXY_LOGIN_PATH}`);
    const response = await handleProxy(request, PROXY_LOGIN_PATH);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Sign-in browser</title>');
  });
});