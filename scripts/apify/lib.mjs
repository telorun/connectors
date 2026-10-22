// Shared pieces of the Apify actor generator: the Apify API, the actor list
// (apify/actors.yaml), naming, and the module location conventions.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR_DIR = join(ROOT, "apify");
export const ACTORS_FILE = join(VENDOR_DIR, "actors.yaml");
/** The hand-written core module every generated module imports. */
export const CORE_DIR_NAME = "apify";

const API = (process.env.APIFY_API_URL ?? "https://api.apify.com").replace(/\/+$/, "") + "/v2";

// ---------------------------------------------------------------------------
// Apify API
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {}

/**
 * GET an Apify API path and return the parsed JSON. Every endpoint used here is
 * public; APIFY_TOKEN, when set, only raises the rate limit. Network errors,
 * 429 and 5xx are retried with backoff; anything else fails loudly, and a 404
 * is a NotFoundError so callers can tell "gone" from "broken".
 */
export async function apifyGet(path, { attempts = 4 } = {}) {
  const headers = { Accept: "application/json" };
  if (process.env.APIFY_TOKEN) headers.Authorization = `Bearer ${process.env.APIFY_TOKEN}`;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    let res;
    try {
      res = await fetch(API + path, { headers, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.status === 404) throw new NotFoundError(`GET ${path}: 404 Not Found`);
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`GET ${path}: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw lastError;
}

/** `user/name` → the `user~name` form Apify's URL paths take. */
export const apiActorId = (id) => id.replace("/", "~");

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Directory (and publish repository) name of an actor's module: `<user>-<actor>`. */
export function moduleDirName(id) {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The module's metadata.name — PascalCase of `<user>-<actor>`. */
export function moduleName(id) {
  const name = id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  return /^[0-9]/.test(name) ? `Actor${name}` : name;
}

export const moduleDir = (id) => join(VENDOR_DIR, moduleDirName(id));

// ---------------------------------------------------------------------------
// apify/actors.yaml
// ---------------------------------------------------------------------------

const ACTORS_HEADER = `# Apify actors generated as typed Telo modules — one module per entry, at
# apify/<username>-<name>/, versioned as the actor build it was generated from.
# See apify/apify/docs/generated-actors.md.
#
# scripts/apify/seed.mjs adds the top 100 Store actors by total users and every
# actor published by Apify itself (\`seeded: true\`). It never removes an entry:
# seeded entries that no longer qualify are listed in its report for a human
# to decide. Add an actor by hand with an empty entry (\`user/name: {}\`);
# delete an entry to stop generating it.
#
# \`deprecated:\` is written by scripts/apify/generate.mjs when the actor is gone
# from Apify or marked deprecated there. Its module is kept, and no longer
# updated.
`;

/** The actor list as a plain `{ "user/name": { seeded?, deprecated? } }` map. */
export function readActors() {
  if (!existsSync(ACTORS_FILE)) return {};
  const doc = YAML.parse(readFileSync(ACTORS_FILE, "utf8")) ?? {};
  const actors = doc.actors ?? {};
  for (const [id, entry] of Object.entries(actors)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(id)) throw new Error(`${ACTORS_FILE}: '${id}' is not a 'user/name' actor id`);
    if (entry !== null && typeof entry !== "object") throw new Error(`${ACTORS_FILE}: '${id}' must map to an object`);
    actors[id] = entry ?? {};
  }
  return actors;
}

export function writeActors(actors) {
  const doc = new YAML.Document({
    actors: Object.fromEntries(
      Object.keys(actors)
        .sort()
        .map((id) => [id, actors[id]]),
    ),
  });
  // One line per actor: `user/name: { seeded: true }`.
  for (const pair of doc.get("actors").items) pair.value.flow = true;
  writeFileSync(ACTORS_FILE, ACTORS_HEADER + doc.toString({ lineWidth: 0, flowCollectionPadding: true }));
}

/** Module directories (relative to the repo root) of every listed actor that has been generated. */
export function generatedModulePaths() {
  return Object.keys(readActors())
    .map((id) => `apify/${moduleDirName(id)}`)
    .filter((p) => existsSync(join(ROOT, p, "telo.yaml")));
}

/** metadata.version of a generated module's telo.yaml, or null when absent. */
export function readModuleVersion(dir) {
  const file = join(dir, "telo.yaml");
  if (!existsSync(file)) return null;
  const first = YAML.parseAllDocuments(readFileSync(file, "utf8"))[0];
  return first?.toJS({ customTags: TELO_TAGS })?.metadata?.version ?? null;
}

/** Parse-only tags so a Telo manifest reads as plain data. */
export const TELO_TAGS = [
  { tag: "!cel", resolve: (s) => s },
  { tag: "!ref", resolve: (s) => s },
];

/** Write a report (markdown) to `--report <file>` when given, and echo it to stdout. */
export function emitReport(argv, markdown) {
  const i = argv.indexOf("--report");
  if (i !== -1) writeFileSync(argv[i + 1], markdown);
  process.stdout.write(markdown);
}
