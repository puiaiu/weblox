// @mercuryworkshop/wisp-js ships no types; only what server.ts uses.
declare module "@mercuryworkshop/wisp-js/server" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  export const server: {
    options: { hostname_whitelist?: RegExp[]; port_whitelist?: (number | [number, number])[] };
    routeRequest(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  };
  export const logging: { WARN: number; set_level(level: number): void };
}
