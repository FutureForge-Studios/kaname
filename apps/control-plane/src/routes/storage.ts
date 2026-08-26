import type { FastifyInstance } from "fastify";
import { desc, eq } from "@kaname/db";
import { storageSamples } from "@kaname/db/schema";
import {
  fileKind,
  storageCategoryKind,
  storageQuery,
  type DiskUsage,
  type FileKind,
  type StorageBreakdown,
  type StorageCategory,
  type StorageCategoryKind,
  type StorageLargestEntry,
} from "@kaname/contract";
import { accepted, item, parseQuery } from "../http/plugin.js";
import { ApiException } from "../lib/errors.js";
import { enqueueServerJob, loadServer } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Storage.
 *
 * Walking a disk costs real IO on a live host, so this never happens on
 * a page view: the panel serves the last sample and says how old it is,
 * and a refresh is an explicit job (KD-012). Hiding the staleness would
 * be the dishonest version of the same trade.
 * ------------------------------------------------------------------ */

const storageReadQuery = storageQuery.pick({ server_id: true });
const storageSampleQuery = storageQuery.omit({ refresh: true });

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/storage", async (req, reply) => {
    const q = parseQuery(req, storageReadQuery);
    const server = await loadServer(req, q.server_id, "files.manager:read");

    const rows = await req.ctx.db
      .select()
      .from(storageSamples)
      .where(eq(storageSamples.serverId, server.id))
      .orderBy(desc(storageSamples.sampledAt))
      .limit(1);

    const sample = rows[0];
    if (!sample) {
      throw new ApiException("not_found", `Kaname has never sampled storage on ${server.name}.`, {
        remediation: {
          summary:
            "Walking a filesystem is expensive, so it only runs when asked. Take a sample — it runs as a job and the breakdown appears here when it finishes.",
          actions: [{ label: "Take a sample", action: "storage.sample" }],
        },
      });
    }

    // Categories are shares of what is actually consumed, not of the
    // whole device: "mail is 40% of your disk" is a different claim from
    // "mail is 40% of what you have used".
    const denominator = sample.used > 0 ? sample.used : sample.total;
    const categories: StorageCategory[] = sample.categories.map((c) => ({
      label: c.label,
      path: c.path,
      bytes: c.bytes,
      percent: share(c.bytes, denominator),
      kind: categoryKind(c.kind),
    }));

    const largest: StorageLargestEntry[] = sample.largest.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      kind: entryKind(entry.kind),
      modified_at: new Date(entry.modified_at).toISOString(),
    }));

    const breakdown: StorageBreakdown = {
      server_id: server.id,
      server_name: server.name,
      total: sample.total,
      used: sample.used,
      available: sample.available,
      used_percent: share(sample.used, sample.total),
      sampled_at: sample.sampledAt.toISOString(),
      mounts: sample.mounts as DiskUsage[],
      categories,
      largest,
    };
    return item(reply, breakdown);
  });

  app.post("/storage/sample", async (req, reply) => {
    const q = parseQuery(req, storageSampleQuery);
    const server = await loadServer(req, q.server_id, "files.manager:read");

    const job = await enqueueServerJob(req, {
      type: "fs.usage",
      server,
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      params: { path: q.path, depth: q.depth },
    });
    return accepted(reply, job);
  });
}

function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/** A sample written by an older agent may carry a label we no longer know. */
function categoryKind(value: string): StorageCategoryKind {
  const parsed = storageCategoryKind.safeParse(value);
  return parsed.success ? parsed.data : "other";
}

function entryKind(value: string): FileKind {
  const parsed = fileKind.safeParse(value);
  return parsed.success ? parsed.data : "directory";
}
