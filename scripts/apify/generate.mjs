#!/usr/bin/env node
// Generate one typed Telo module per actor in apify/actors.yaml.
//
// For each actor it reads the actor and its default build from the Apify API
// (public endpoints; APIFY_TOKEN only raises the rate limit) and writes
// apify/<user>-<actor>/:
//
//   telo.yaml          — `Run` + `Start` kinds over the core apify/apify module,
//                        typed from the build's input and dataset schemas, with
//                        metadata.version = the build number. Rewritten ONLY
//                        when the build number changed (or with --force): an
//                        unchanged version is already published and can never
//                        be published again, so its manifest stays as it was.
//   docs/README.md     — always regenerated (pricing and descriptions move
//                        between builds; docs are not part of the payload).
//   CHANGELOG.md       — one entry per new build.
//
// An actor that is gone from Apify (404) or marked deprecated there gets
// `deprecated:` in apify/actors.yaml and a banner in its docs; its module is
// kept. Any other failure fails the run after every actor was tried, so a
// partial refresh is never mistaken for a complete one.
//
// Usage:
//   node scripts/apify/generate.mjs [--only user/name ...] [--force] [--report <file>]
//   node scripts/apify/generate.mjs --fixture   # regenerate the test fixture module
// Env:
//   APIFY_TOKEN    optional
//   APIFY_API_URL  optional, defaults to https://api.apify.com

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  NotFoundError,
  ROOT,
  apiActorId,
  apifyGet,
  emitReport,
  mapLimit,
  moduleDir,
  moduleDirName,
  readActors,
  readModuleVersion,
  writeActors,
} from "./lib.mjs";
import { renderChangelogEntry, renderDocs, renderManifest } from "./render.mjs";

const argv = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
const SEMVER = /^\d+\.\d+\.\d+$/;

if (argv.includes("--fixture")) {
  generateFixture();
  process.exit(0);
}

const force = argv.includes("--force");
const only = argv.flatMap((a, i) => (argv[i - 1] === "--only" ? [a] : []));

const actors = readActors();
const ids = only.length ? only : Object.keys(actors).sort();
for (const id of ids) if (!(id in actors)) throw new Error(`--only ${id}: not listed in apify/actors.yaml`);

const results = await mapLimit(ids, 4, async (id) => {
  try {
    return await generateOne(id);
  } catch (err) {
    return { id, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
});

let actorsChanged = false;
for (const r of results) {
  const entry = actors[r.id];
  if (r.outcome === "deprecated" && !entry.deprecated) {
    entry.deprecated = r.detail;
    actorsChanged = true;
  } else if (r.outcome !== "deprecated" && r.outcome !== "failed" && entry.deprecated) {
    delete entry.deprecated; // back on Apify
    actorsChanged = true;
  }
}
if (actorsChanged) writeActors(actors);

emitReport(argv, report(results));
if (results.some((r) => r.outcome === "failed")) process.exit(1);

// ---------------------------------------------------------------------------

async function generateOne(id) {
  const dir = moduleDir(id);
  let act;
  try {
    act = (await apifyGet(`/acts/${apiActorId(id)}`)).data;
  } catch (err) {
    if (err instanceof NotFoundError) return deprecate(id, dir, `${today}: no longer available on Apify`);
    throw err;
  }
  if (act.isDeprecated) return deprecate(id, dir, `${today}: marked deprecated on Apify`);

  let build;
  try {
    build = (await apifyGet(`/acts/${apiActorId(id)}/builds/default`)).data;
  } catch (err) {
    if (err instanceof NotFoundError) return deprecate(id, dir, `${today}: has no default build on Apify`);
    throw err;
  }
  if (!SEMVER.test(build.buildNumber ?? "")) {
    throw new Error(`default build number '${build.buildNumber}' is not semver`);
  }

  const previous = readModuleVersion(dir);
  const version = build.buildNumber;
  let outcome = "unchanged";
  mkdirSync(join(dir, "docs"), { recursive: true });
  if (previous !== version || force) {
    writeFileSync(join(dir, "telo.yaml"), renderManifest({ id, act, build }));
    if (previous !== version) {
      outcome = previous ? "updated" : "added";
      const changelog = join(dir, "CHANGELOG.md");
      const prior = existsSync(changelog) ? readFileSync(changelog, "utf8").replace(/^# Changelog\n+/, "") : "";
      writeFileSync(
        changelog,
        `# Changelog\n\n${renderChangelogEntry({ id, build, previous, date: today })}${prior ? `\n${prior}` : ""}`,
      );
    } else {
      outcome = "regenerated";
    }
  }
  writeFileSync(join(dir, "docs", "README.md"), renderDocs({ id, act, build }));
  return { id, outcome, previous, version };
}

/** Keep the module; record why it is deprecated in its docs. */
function deprecate(id, dir, reason) {
  const recorded = actors[id]?.deprecated ?? reason;
  const docs = join(dir, "docs", "README.md");
  if (existsSync(docs)) {
    const text = readFileSync(docs, "utf8");
    if (!text.includes("> **Deprecated**")) {
      writeFileSync(
        docs,
        text.replace(/^(# .*\n\n)/m, `$1> **Deprecated** — ${recorded}. This module is no longer updated.\n\n`),
      );
    }
  }
  return { id, outcome: "deprecated", detail: recorded, version: readModuleVersion(dir) };
}

function report(rows) {
  const by = (o) => rows.filter((r) => r.outcome === o);
  const out = ["## Apify actor modules", ""];
  const section = (title, list, fmt) => {
    if (!list.length) return;
    out.push(`### ${title} (${list.length})`, "", ...list.map(fmt), "");
  };
  section("New modules", by("added"), (r) => `- \`apify/${moduleDirName(r.id)}\` — ${r.id} build ${r.version}`);
  section("New builds", by("updated"), (r) => `- \`apify/${moduleDirName(r.id)}\` — ${r.previous} → ${r.version}`);
  section("Regenerated in place (--force; not republished)", by("regenerated"), (r) => `- \`apify/${moduleDirName(r.id)}\` — ${r.version}`);
  section("Deprecated", by("deprecated"), (r) => `- \`${r.id}\` — ${r.detail}`);
  section("FAILED", by("failed"), (r) => `- \`${r.id}\` — ${r.detail}`);
  out.push(`${by("unchanged").length} module(s) unchanged.`, "");
  return out.join("\n");
}

/** The sample module the core module's tests import, from a checked-in fixture actor. */
function generateFixture() {
  const { id, act, build } = JSON.parse(readFileSync(join(ROOT, "scripts/apify/fixtures/acme-sample.json"), "utf8"));
  const dir = join(ROOT, "apify/apify/tests/__fixtures__/acme-sample");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "telo.yaml"), renderManifest({ id, act, build, coreImport: "../../.." }));
  console.log(`wrote ${join(dir, "telo.yaml")}`);
}
