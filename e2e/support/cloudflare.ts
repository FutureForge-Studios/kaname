import { createServer, type Server } from "node:http";
import { cloudflarePort, host } from "./config.js";

/* ------------------------------------------------------------------ *
 * A stand-in for Cloudflare's DNS API, on loopback.
 *
 * The control plane is pointed at it from boot (KANAME_CLOUDFLARE_API_URL
 * in stack.ts) and talks to it through the same CloudflareProvider it
 * uses in production, so a sync or apply here is the real request and
 * response shape, not a mock of Kaname. It holds one zone in memory and
 * only accepts the bearer token the spec saved through the panel, so a
 * request that skipped the sealed-token lookup would be refused.
 * ------------------------------------------------------------------ */

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
}

export interface FakeCloudflare {
  token: string;
  zone: { id: string; name: string; name_servers: string[] };
  records: FakeRecord[];
  /** Writes in arrival order, as "METHOD name content". */
  writes: string[];
  close(): Promise<void>;
}

export async function startFakeCloudflare(
  zoneName: string,
  token: string,
): Promise<FakeCloudflare> {
  const state: Omit<FakeCloudflare, "close"> = {
    token,
    zone: {
      id: `zone-${zoneName.replace(/[^a-z0-9]/g, "")}`,
      name: zoneName,
      name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    },
    records: [],
    writes: [],
  };
  let seq = 0;
  const base = "/client/v4";

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const reply = (status: number, result: unknown, errors: unknown[] = []) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: status < 400,
            errors,
            result,
            result_info: { page: 1, total_pages: 1 },
          }),
        );
      };
      if (req.headers.authorization !== `Bearer ${state.token}`) {
        return reply(403, null, [{ code: 10000, message: "Authentication error" }]);
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
      const records = `/zones/${state.zone.id}/dns_records`;

      if (path === "/zones") {
        return reply(200, url.searchParams.get("name") === state.zone.name ? [state.zone] : []);
      }
      if (path === `/zones/${state.zone.id}`) return reply(200, state.zone);
      if (path === records && req.method === "GET") return reply(200, state.records);

      const body = raw ? (JSON.parse(raw) as Omit<FakeRecord, "id">) : null;
      if (path === records && req.method === "POST" && body) {
        const created: FakeRecord = { ...body, id: `rec-${++seq}` };
        state.records.push(created);
        state.writes.push(`POST ${created.name} ${created.content}`);
        return reply(200, created);
      }
      if (path.startsWith(`${records}/`)) {
        const id = path.slice(records.length + 1);
        const at = state.records.findIndex((r) => r.id === id);
        if (at < 0) return reply(404, null, [{ code: 81044, message: "Record does not exist." }]);
        if (req.method === "DELETE") {
          const [gone] = state.records.splice(at, 1);
          state.writes.push(`DELETE ${gone!.name} ${gone!.content}`);
          return reply(200, { id });
        }
        if (body) {
          state.records[at] = { ...state.records[at]!, ...body, id };
          state.writes.push(`${req.method} ${body.name} ${body.content}`);
          return reply(200, state.records[at]);
        }
      }
      return reply(404, null, [{ code: 7003, message: `No route for ${req.method} ${path}` }]);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cloudflarePort, host, () => resolve());
  });

  return Object.assign(state, {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
