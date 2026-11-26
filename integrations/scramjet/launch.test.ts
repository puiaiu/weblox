import { expect, it } from "bun:test";
import { FollowError, isProtocolUri, lookupFollow, parseFollowUri, parseGamesStart, parseLaunchUri } from "./launch";

const launcher = (query: string) =>
  `roblox-player:1+launchmode:play+gameinfo:abc+placelauncherurl:${encodeURIComponent(`https://assetgame.roblox.com/game/placelauncher.ashx?${query}`)}`;

it("reads placeId and server from a games/start url", () => {
  expect(parseGamesStart("https://www.roblox.com/games/start?placeId=920587237")).toEqual({ placeId: "920587237" });
  expect(parseGamesStart("https://play.roblox.com/games/start?PlaceId=1&gameInstanceId=ab12-cd34")).toEqual({ placeId: "1", serverId: "ab12-cd34" });
});

it("rejects other hosts, ports, paths and bad ids", () => {
  expect(parseGamesStart("https://evil.example/games/start?placeId=1")).toBeNull();
  expect(parseGamesStart("https://www.roblox.com.evil.example/games/start?placeId=1")).toBeNull();
  expect(parseGamesStart("https://www.roblox.com:8443/games/start?placeId=1")).toBeNull();
  expect(parseGamesStart("https://www.roblox.com/games/other?placeId=1")).toBeNull();
  expect(parseGamesStart("https://www.roblox.com/games/start?placeId=0")).toBeNull();
  expect(parseGamesStart("https://www.roblox.com/games/start?placeId=abc")).toBeNull();
  expect(parseGamesStart("javascript:alert(1)")).toBeNull();
});

it("reads roblox-player launches for a place and for one server", () => {
  expect(parseLaunchUri(launcher("request=RequestGame&placeId=77"))).toEqual({ placeId: "77" });
  expect(parseLaunchUri(launcher("request=RequestGameJob&placeId=77&gameId=11111111-2222-3333-4444-555555555555"))).toEqual({
    placeId: "77",
    serverId: "11111111-2222-3333-4444-555555555555",
  });
  expect(parseLaunchUri(launcher("request=RequestGameJob&placeId=77"))).toBeNull();
  expect(parseLaunchUri(launcher("request=RequestFollowUser&userId=9"))).toBeNull();
});

it("only plays, only on roblox hosts and only through PlaceLauncher", () => {
  expect(parseLaunchUri("roblox-player:1+launchmode:app+placelauncherurl:x")).toBeNull();
  const foreign = `roblox-player:1+launchmode:play+placelauncherurl:${encodeURIComponent("https://evil.example/game/placelauncher.ashx?request=RequestGame&placeId=1")}`;
  expect(parseLaunchUri(foreign)).toBeNull();
  const wrongPath = `roblox-player:1+launchmode:play+placelauncherurl:${encodeURIComponent("https://www.roblox.com/other?request=RequestGame&placeId=1")}`;
  expect(parseLaunchUri(wrongPath)).toBeNull();
});

it("reads roblox:// experience links", () => {
  expect(parseLaunchUri("roblox://experiences/start?placeId=123&gameInstanceId=aa-bb")).toEqual({ placeId: "123", serverId: "aa-bb" });
  expect(parseLaunchUri("roblox://placeId=5")).toEqual({ placeId: "5" });
  expect(parseLaunchUri("roblox://experiences/start?placeId=nope")).toBeNull();
});

it("reads friend follow requests and recognises protocol uris", () => {
  expect(parseFollowUri(launcher("request=RequestFollowUser&userId=4242"))).toEqual({ userId: "4242", domain: "roblox.com" });
  expect(parseFollowUri(launcher("request=RequestFollowUser&userId=x"))).toBeNull();
  expect(isProtocolUri("roblox-player:1+launchmode:play")).toBe(true);
  expect(isProtocolUri("roblox://experiences/start?placeId=1")).toBe(true);
  expect(isProtocolUri("https://www.roblox.com/")).toBe(false);
});

it("finds a friend's server, repeating the POST with Roblox's CSRF token", async () => {
  const calls: RequestInit[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    calls.push(init);
    if (calls.length === 1) return new Response("", { status: 403, headers: { "x-csrf-token": "tok" } });
    return Response.json({ userPresences: [{ userPresenceType: 2, placeId: 606849621, gameId: "11111111-2222-3333-4444-555555555555" }] });
  };
  await expect(lookupFollow(fetcher, { userId: "1", domain: "roblox.com" })).resolves.toEqual({
    placeId: "606849621",
    serverId: "11111111-2222-3333-4444-555555555555",
  });
  expect(new Headers(calls[1]!.headers).get("x-csrf-token")).toBe("tok");
});

it("says so when the friend is not in a game", async () => {
  const fetcher = async () => Response.json({ userPresences: [{ userPresenceType: 1, placeId: null }] });
  await expect(lookupFollow(fetcher, { userId: "1", domain: "roblox.com" })).rejects.toEqual(new FollowError("not-playing"));
});
