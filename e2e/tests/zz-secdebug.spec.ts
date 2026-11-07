import { test } from "@playwright/test";
import { owner, server } from "../support/secops.js";
test("debug", async () => {
  const api = await owner();
  const f = await server("forge-01");
  const all = await api.get<{ts:string;level:string;message:string}[]>(`/logs/search?server_id=${f.id}&source=journal&limit=500`);
  const w = await api.get<{ts:string;level:string;message:string}[]>(`/logs/search?server_id=${f.id}&source=journal&level=warn&limit=500`);
  const e = await api.get<{ts:string;level:string;message:string}[]>(`/logs/search?server_id=${f.id}&source=journal&level=error&limit=500`);
  const lv = (r: {level:string}[]) => JSON.stringify(r.reduce((m: Record<string,number>, x) => (m[x.level]=(m[x.level]??0)+1, m), {}));
  console.log("SECDEBUG all", all.length, lv(all), "warn", w.length, lv(w), "error", e.length, lv(e));
  console.log("SECDEBUG range all", all.at(-1)?.ts, all[0]?.ts, "warn", w.at(-1)?.ts, w[0]?.ts);
});
