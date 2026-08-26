import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AGENT_METHODS,
  AGENT_EVENT_TOPICS,
  AGENT_PROTOCOL_VERSION,
  AGENT_SUBPROTOCOL,
  MAX_CHUNK_BYTES,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MULTIPLIER,
  STREAM_WINDOW,
  type AgentMethod,
} from "../src/agent/index.js";

/* ------------------------------------------------------------------ *
 * Emits the agent method manifest that the Go agent embeds and asserts
 * against (KD-007).
 *
 * Full struct generation was rejected as too much machinery for the
 * payoff, but the *method list* is the part that actually drifts — a
 * method renamed here and not there fails silently at runtime. Embedding
 * the manifest turns that into a failing `go test`.
 * ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "..", "..", "agent", "internal", "rpc");

interface ManifestMethod {
  name: string;
  stream: string;
  requires: readonly string[];
  read_only: boolean;
  summary: string;
  params: unknown;
  result: unknown;
}

const methods: ManifestMethod[] = (Object.keys(AGENT_METHODS) as AgentMethod[])
  .sort()
  .map((name) => {
    const spec = AGENT_METHODS[name];
    return {
      name,
      stream: spec.stream,
      requires: spec.requires,
      read_only: spec.readOnly,
      summary: spec.summary,
      params: zodToJsonSchema(spec.params, { target: "jsonSchema7", $refStrategy: "none" }),
      result: zodToJsonSchema(spec.result, { target: "jsonSchema7", $refStrategy: "none" }),
    };
  });

const manifest = {
  protocol: AGENT_PROTOCOL_VERSION,
  subprotocol: AGENT_SUBPROTOCOL,
  limits: {
    stream_window: STREAM_WINDOW,
    max_chunk_bytes: MAX_CHUNK_BYTES,
    ping_interval_ms: PING_INTERVAL_MS,
    ping_timeout_multiplier: PING_TIMEOUT_MULTIPLIER,
  },
  event_topics: [...AGENT_EVENT_TOPICS].sort(),
  methods,
};

mkdirSync(outDir, { recursive: true });
const target = join(outDir, "methods.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`wrote ${methods.length} methods to ${target}`);
