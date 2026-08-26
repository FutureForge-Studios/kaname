import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ApiException } from "../lib/errors.js";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * Agent distribution.
 *
 * The enrollment command a new server runs points at this control
 * plane, not at a third-party CDN — so the binary an operator installs
 * comes from the same host that will manage it, over the same TLS.
 * ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));

/** Only these are servable; the arch comes from a URL parameter. */
const TARGETS = new Set(["linux-amd64", "linux-arm64", "linux-armv7"]);

export async function registerDistributionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const roots = [
    process.env.KANAME_AGENT_DIST_DIR,
    // Where the image puts them.
    resolve(here, "..", "..", "public"),
    // Where they are in a checkout: install.sh at the repo root, agent
    // binaries wherever `go build` left them.
    resolve(here, "..", "..", "..", ".."),
    resolve(here, "..", "..", "..", "..", "agent", "bin"),
  ].filter((p): p is string => Boolean(p));

  app.get("/install.sh", async (_req, reply) => {
    const path = await findFile(roots, "install.sh");
    if (!path) {
      throw new ApiException("not_found", "The agent installer is not bundled with this build.", {
        remediation: {
          summary:
            "Build the agent and place install.sh alongside it, or install kanamed manually.",
          actions: [],
        },
      });
    }
    return reply
      .type("text/x-shellscript; charset=utf-8")
      .header("cache-control", "no-store")
      .send(createReadStream(path));
  });

  app.get<{ Params: { target: string } }>("/download/kanamed-:target", async (req, reply) => {
    const target = req.params.target;
    if (!TARGETS.has(target)) {
      throw new ApiException("not_found", `No agent build for ${target}.`, {
        detail: { available: [...TARGETS] },
      });
    }

    const path = await findFile(roots, `kanamed-${target}`);
    if (!path) {
      ctx.log.warn({ target }, "agent binary requested but not present in this build");
      throw new ApiException("not_found", `The ${target} agent binary is not bundled.`, {
        remediation: {
          summary: `Build it with: cd agent && GOOS=linux GOARCH=${target.split("-")[1]} go build -o bin/kanamed-${target} ./cmd/kanamed`,
          actions: [
            {
              label: "Copy command",
              copy: `cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=${target.split("-")[1]} go build -o bin/kanamed-${target} ./cmd/kanamed`,
            },
          ],
        },
      });
    }

    const info = await stat(path);
    return reply
      .type("application/octet-stream")
      .header("content-length", info.size)
      .header("content-disposition", `attachment; filename="kanamed-${target}"`)
      .send(createReadStream(path));
  });
}

async function findFile(roots: string[], name: string): Promise<string | null> {
  for (const root of roots) {
    const candidate = join(root, name);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* try the next root */
    }
  }
  return null;
}
