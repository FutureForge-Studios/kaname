import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  absolutePath,
  archiveInput,
  browseQuery,
  can,
  chmodInput,
  chownInput,
  copyInput,
  deleteInput,
  extractInput,
  fileMode,
  fileStatQuery,
  mkdirInput,
  moveInput,
  readFileQuery,
  uuid,
  writeFileInput,
  type FileContent,
  type FileEntry,
  type FileListing,
  type FileRow,
  type JobType,
  type Permission,
} from "@kaname/contract";
import {
  MAX_CHUNK_BYTES,
  type AgentMethod,
  type MethodParams,
  type MethodResult,
} from "@kaname/contract/agent";
import { accepted, helpers, item, parseBody, parseQuery } from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { ApiException, agentOffline, badRequest, conflict, fromAgentError } from "../lib/errors.js";
import {
  drained,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * File manager.
 *
 * Browse, stat and read are live pass-throughs and are never cached: a
 * directory listing is stale the moment it is taken, and a stale one is
 * worse than a slow one because the operator acts on what they see.
 * Everything that changes a byte on the host is a job (KD-008).
 *
 * Upload and download are the two deliberate exceptions to "202 with a
 * job": both carry a body that only exists for the lifetime of the
 * request, so there is nothing a queued job row could hold. They stream
 * through the same agent socket, chunked and cancellable, and upload
 * still writes an audit entry of its own.
 * ------------------------------------------------------------------ */

/** Browse/stat: fast enough that a slow host should surface as an error, not a hang. */
const LIVE_TIMEOUT_MS = 15_000;
/** fs.read pulls up to 8 MiB inline for the editor. */
const READ_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 60 * 60_000;
/**
 * Raw bytes per upload chunk. base64 turns 3 bytes into 4, so this keeps
 * every frame's payload at exactly MAX_CHUNK_BYTES, the same split the
 * agent uses when it sends.
 */
const UPLOAD_CHUNK_BYTES = (MAX_CHUNK_BYTES / 4) * 3;
/**
 * Uploads hold a multipart body open for the whole transfer and share
 * one agent socket; past this many per host they only slow each other.
 */
const MAX_UPLOADS_PER_SERVER = 2;
const activeUploads = new Map<string, number>();

/** Directories sort before files no matter which column is chosen. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const uploadQuery = z.object({
  server_id: uuid,
  /** Destination directory; the filename comes from the multipart part. */
  path: absolutePath,
  /**
   * Required: the frame envelope has no client-side end marker, so the
   * agent uses the declared size to know when the body is complete.
   */
  size: z.coerce.number().int().nonnegative(),
  mode: fileMode.optional(),
  overwrite: z.coerce.boolean().default(false),
});

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ browse ---------------------------- */

  app.get("/files", async (req, reply) => {
    const q = parseQuery(req, browseQuery);
    const server = await loadConnectedServer(req, q.server_id, "files.manager:read");

    const listing = await live(req, server, "fs.list", {
      path: q.path,
      show_hidden: q.show_hidden,
      limit: 1000,
    });

    const principal = helpers(req).requirePrincipal();
    const result: FileListing = {
      ...listing,
      entries: sortEntries(listing.entries, q.sort, q.order),
      server_id: server.id,
      server_name: server.name,
      listed_at: new Date().toISOString(),
      // The agent runs as root, so mode bits never decide this. What
      // decides it is whether this caller may write to this host at all;
      // a read-only mount surfaces as the job's own error.
      writable: can(principal.grants, "files.manager:write", server.id),
    };
    return item(reply, result);
  });

  app.get("/files/stat", async (req, reply) => {
    const q = parseQuery(req, fileStatQuery);
    const server = await loadConnectedServer(req, q.server_id, "files.manager:read");

    const entry = await live(req, server, "fs.stat", { path: q.path });
    const row: FileRow = { ...entry, server_id: server.id, server_name: server.name };
    return item(reply, row);
  });

  app.get("/files/read", async (req, reply) => {
    const q = parseQuery(req, readFileQuery);
    const server = await loadConnectedServer(req, q.server_id, "files.manager:read");

    const entry = await live(req, server, "fs.stat", { path: q.path });
    if (entry.kind === "directory") {
      throw badRequest(`${q.path} is a directory.`, { path: "expected a file" });
    }

    const read = await live(
      req,
      server,
      "fs.read",
      { path: q.path, max_bytes: q.max_bytes },
      READ_TIMEOUT_MS,
    );

    const content: FileContent = {
      server_id: server.id,
      path: q.path,
      content: read.content,
      encoding: read.encoding,
      truncated: read.truncated,
      size: read.size,
      mode: entry.mode,
      mime: entry.mime,
      read_at: new Date().toISOString(),
    };
    return item(reply, content);
  });

  /* ----------------------------- mutations -------------------------- */

  app.post("/files/write", async (req, reply) => {
    const body = parseBody(req, writeFileInput);
    return submit(req, reply, "fs.write", body.server_id, "files.manager:write", body.path, {
      path: body.path,
      content: body.content,
      encoding: body.encoding,
      mode: body.mode,
      create_parents: body.create_parents,
    });
  });

  app.post("/files/mkdir", async (req, reply) => {
    const body = parseBody(req, mkdirInput);
    return submit(req, reply, "fs.mkdir", body.server_id, "files.manager:write", body.path, {
      path: body.path,
      mode: body.mode,
      parents: body.parents,
    });
  });

  app.post("/files/move", async (req, reply) => {
    const body = parseBody(req, moveInput);
    if (body.from === body.to) {
      throw badRequest("Source and destination are the same path.", {
        to: "must differ from `from`",
      });
    }
    if (body.to.startsWith(`${body.from}/`)) {
      throw conflict(`Cannot move ${body.from} into itself.`, {
        summary:
          "The destination is inside the source directory, which would move a directory under its own child.",
        actions: [],
      });
    }
    return submit(req, reply, "fs.move", body.server_id, "files.manager:write", body.from, {
      from: body.from,
      to: body.to,
      overwrite: body.overwrite,
    });
  });

  app.post("/files/copy", async (req, reply) => {
    const body = parseBody(req, copyInput);
    if (body.to.startsWith(`${body.from}/`)) {
      throw conflict(`Cannot copy ${body.from} into itself.`, {
        summary: "The destination is inside the source directory, which would recurse without end.",
        actions: [],
      });
    }
    return submit(req, reply, "fs.copy", body.server_id, "files.manager:write", body.from, {
      from: body.from,
      to: body.to,
      overwrite: body.overwrite,
    });
  });

  app.post("/files/delete", async (req, reply) => {
    const body = parseBody(req, deleteInput);
    for (const path of body.paths) {
      if (PROTECTED_PATHS.has(path)) {
        throw conflict(
          `${path} is a system directory and cannot be deleted from the file manager.`,
          {
            summary:
              "Removing it would leave the host unbootable. If this is genuinely what you want, do it from a terminal session, which is recorded.",
            actions: [{ label: "Open terminal", href: "/terminal" }],
          },
        );
      }
    }
    return submit(req, reply, "fs.remove", body.server_id, "files.manager:delete", body.paths[0]!, {
      paths: body.paths,
      recursive: body.recursive,
    });
  });

  app.post("/files/chmod", async (req, reply) => {
    const body = parseBody(req, chmodInput);
    return submit(req, reply, "fs.chmod", body.server_id, "files.manager:write", body.paths[0]!, {
      paths: body.paths,
      mode: body.mode,
      recursive: body.recursive,
    });
  });

  app.post("/files/chown", async (req, reply) => {
    const body = parseBody(req, chownInput);
    return submit(req, reply, "fs.chown", body.server_id, "files.manager:write", body.paths[0]!, {
      paths: body.paths,
      owner: body.owner,
      group: body.group,
      recursive: body.recursive,
    });
  });

  app.post("/files/archive", async (req, reply) => {
    const body = parseBody(req, archiveInput);
    return submit(
      req,
      reply,
      "fs.archive",
      body.server_id,
      "files.manager:write",
      body.destination,
      {
        paths: body.paths,
        destination: body.destination,
        format: body.format,
      },
    );
  });

  app.post("/files/extract", async (req, reply) => {
    const body = parseBody(req, extractInput);
    return submit(req, reply, "fs.extract", body.server_id, "files.manager:write", body.path, {
      path: body.path,
      destination: body.destination,
      overwrite: body.overwrite,
    });
  });

  /* ---------------------------- download ---------------------------- */

  app.get("/files/download", async (req, reply) => {
    const q = parseQuery(req, fileStatQuery);
    const server = await loadConnectedServer(req, q.server_id, "files.manager:read");
    const h = helpers(req);

    // Stat first so a missing file, a directory or a permission problem
    // is a JSON error envelope; once bytes start flowing it can only be
    // a truncated transfer.
    const entry = await live(req, server, "fs.stat", { path: q.path });
    if (entry.kind === "directory") {
      throw conflict(`${q.path} is a directory.`, {
        summary: "Archive it first, then download the archive.",
        actions: [{ label: "Create archive", action: "files.archive" }],
      });
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "fs.download",
      targetType: "path",
      targetId: q.path,
      targetLabel: q.path,
      serverId: server.id,
      metadata: { size: entry.size, mime: entry.mime },
    });

    reply.raw.writeHead(200, {
      "Content-Type": entry.mime ?? "application/octet-stream",
      "Content-Length": String(entry.size),
      "Content-Disposition": contentDisposition(entry.name),
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    const handle = req.ctx.hub.stream(
      server.id,
      "fs.download",
      { path: q.path },
      (data, encoding) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return undefined;
        const ok = reply.raw.write(Buffer.from(data, encoding === "base64" ? "base64" : "utf8"));
        // false means the browser is behind. Waiting here holds the next
        // chunk, and with it the agent, so the file never piles up in heap.
        return ok ? undefined : drained(reply.raw);
      },
      { timeoutMs: TRANSFER_TIMEOUT_MS },
    );

    req.raw.on("close", () => handle.cancel("client disconnected"));

    try {
      await handle.done;
      reply.raw.end();
    } catch (err) {
      // The client already has a Content-Length it will never reach;
      // destroying the socket is the only way to say "this is short".
      req.log.warn({ err, path: q.path, serverId: server.id }, "download stream failed");
      reply.raw.destroy();
    }
    return reply;
  });

  /* ----------------------------- upload ----------------------------- */

  app.post("/files/upload", async (req, reply) => {
    const q = parseQuery(req, uploadQuery);
    const server = await loadConnectedServer(req, q.server_id, "files.manager:write");
    const h = helpers(req);

    if (!req.isMultipart()) {
      throw badRequest("Upload the file as multipart/form-data.", {
        "content-type": "expected multipart/form-data",
      });
    }

    // The slot is taken before the body is touched, so a refused request
    // never reads a multipart stream it is about to abandon.
    acquireUploadSlot(server);
    try {
      const part = await req.file();
      if (!part) {
        throw badRequest("The request contained no file part.", { file: "required" });
      }

      const destination = joinUploadPath(q.path, part.filename);

      const handle = req.ctx.hub.stream(
        server.id,
        "fs.upload",
        { path: destination, size: q.size, mode: q.mode, overwrite: q.overwrite },
        () => undefined,
        { timeoutMs: TRANSFER_TIMEOUT_MS },
      );

      let sent = 0;
      try {
        for await (const chunk of part.file) {
          const buffer = chunk as Buffer;
          for (let offset = 0; offset < buffer.length; offset += UPLOAD_CHUNK_BYTES) {
            // Resolves only once the agent has room, which pauses the
            // multipart stream instead of encoding the whole body up front.
            await handle.send(
              buffer.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString("base64"),
              "base64",
            );
          }
          sent += buffer.length;
        }
      } catch (err) {
        handle.cancel("upload aborted");
        // A send fails because the stream closed; when the agent closed
        // it, its own refusal is the reason worth showing, and `done`
        // carries that.
        const cause =
          err instanceof AgentRpcError
            ? await handle.done.then(
                () => err,
                (reason: unknown) => reason,
              )
            : err;
        throw translateAgentError(server, cause);
      }

      if (sent !== q.size) {
        handle.cancel("declared size did not match the body");
        throw badRequest(
          `The upload declared ${q.size} bytes but the body carried ${sent}. The agent needs the exact size to know where the file ends.`,
          { size: `expected ${sent}` },
        );
      }

      let entry: FileEntry;
      try {
        entry = await handle.done;
      } catch (err) {
        throw translateAgentError(server, err);
      }

      await req.ctx.audit.record({
        actor: h.actor(),
        action: "fs.upload",
        targetType: "path",
        targetId: destination,
        targetLabel: destination,
        serverId: server.id,
        metadata: { size: sent, mime: part.mimetype, overwrite: q.overwrite },
      });
      req.ctx.events.publish(
        "servers",
        "file.uploaded",
        { server_id: server.id, path: destination, size: sent },
        server.id,
      );

      const row: FileRow = { ...entry, server_id: server.id, server_name: server.name };
      return item(reply, row, 201);
    } finally {
      releaseUploadSlot(server.id);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Deleting any of these takes the host down; the file manager refuses. */
const PROTECTED_PATHS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
]);

function acquireUploadSlot(server: ServerRow): void {
  const running = activeUploads.get(server.id) ?? 0;
  if (running >= MAX_UPLOADS_PER_SERVER) {
    throw new ApiException(
      "rate_limited",
      `${server.name} already has ${MAX_UPLOADS_PER_SERVER} uploads in progress.`,
      {
        detail: { limit: MAX_UPLOADS_PER_SERVER },
        remediation: {
          summary:
            "Uploads to one host share its agent connection, so more of them at once only slow each other down. Wait for one to finish, then retry.",
          actions: [{ label: "Browse files", href: `/files?server_id=${server.id}` }],
        },
      },
    );
  }
  activeUploads.set(server.id, running + 1);
}

function releaseUploadSlot(serverId: string): void {
  const running = activeUploads.get(serverId) ?? 0;
  if (running <= 1) activeUploads.delete(serverId);
  else activeUploads.set(serverId, running - 1);
}

/** Every file mutation is a job, so "we do not know yet" stays resumable (KD-008). */
async function submit(
  req: FastifyRequest,
  reply: FastifyReply,
  type: JobType,
  serverId: string,
  permission: Permission,
  label: string,
  params: Record<string, unknown>,
): Promise<FastifyReply> {
  const server = await loadServer(req, serverId, permission);
  const job = await enqueueServerJob(req, {
    type,
    server,
    targetType: "path",
    targetId: label,
    targetLabel: label,
    params,
  });
  return accepted(reply, job);
}

/** Read-only pass-through. An agent failure becomes a specific error, never a 500. */
async function live<M extends AgentMethod>(
  req: FastifyRequest,
  server: ServerRow,
  method: M,
  params: MethodParams<M>,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<MethodResult<M>> {
  try {
    return await req.ctx.hub.call(server.id, method, params, { timeoutMs });
  } catch (err) {
    throw translateAgentError(server, err);
  }
}

function translateAgentError(server: ServerRow, err: unknown): Error {
  if (err instanceof AgentOfflineError) return agentOffline(server.name, server.lastSeenAt);
  if (err instanceof AgentRpcError) return fromAgentError(server.name, err.agentError);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The filename comes from the browser, so it is joined here and then
 * re-validated with the contract's own path schema before it leaves the
 * control plane. The agent validates it a second time.
 */
function joinUploadPath(directory: string, filename: string | undefined): string {
  const name = filename?.trim();
  if (!name || name === "." || name === "..") {
    throw badRequest("The uploaded part has no usable filename.", { filename: "required" });
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw badRequest("A filename may not contain a path separator.", {
      filename: "must be a bare filename",
    });
  }

  const candidate = `${directory.replace(/\/+$/, "")}/${name}`;
  const parsed = absolutePath.safeParse(candidate);
  if (!parsed.success) {
    throw new ApiException("validation_failed", `${candidate} is not a valid destination path.`, {
      fields: { path: parsed.error.issues[0]?.message ?? "invalid path" },
    });
  }
  return parsed.data;
}

function sortEntries(
  entries: FileEntry[],
  key: "name" | "size" | "modified",
  order: "asc" | "desc",
): FileEntry[] {
  const direction = order === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "directory") return -1;
      if (b.kind === "directory") return 1;
    }
    if (key === "size") return (a.size - b.size) * direction;
    if (key === "modified") {
      return (Date.parse(a.modified_at) - Date.parse(b.modified_at)) * direction;
    }
    return collator.compare(a.name, b.name) * direction;
  });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
