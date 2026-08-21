#!/usr/bin/env node
// Renders the module Version PR's body from the per-vendor release plans.
//
// WHY THE BODY IS GENERATED RATHER THAN STATIC. Merging this PR publishes every
// module it lists. A body that says "versions moved" describes the mechanism and
// hides the decision; what a reviewer needs is every module that will publish, the
// version it moves to, and the changelog entries that will ship with it. All of it
// is already in the plan, so restating it here costs nothing and leaves nothing to
// be taken on trust.
//
// The plans MUST be captured before `telo release apply`, which consumes the
// fragments the entries come from.
//
// Usage: node scripts/module-release-pr-body.mjs <plans-dir> [> body.md]

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const KIND_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/** GitHub rejects a PR body over 65536 characters, and the whole point of this body
 *  is that merging publishes what it lists — a request that 422s leaves the release
 *  PR with no body at all. The headroom is for the trailer `create-pull-request`
 *  appends. */
const MAX_BODY = 60_000;

/** Longest a single changelog entry may run before it is cut. Applied only when the
 *  full body does not fit. */
const MAX_ENTRY = 600;

const plansDir = process.argv[2];
if (!plansDir) {
  console.error("usage: node scripts/module-release-pr-body.mjs <plans-dir>");
  process.exit(2);
}

const vendors = readdirSync(plansDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ vendor: basename(f, ".json"), plan: JSON.parse(readFileSync(join(plansDir, f), "utf8")) }))
  .filter(({ plan }) => (plan.modules ?? []).length > 0);

function render({ entryLimit, entries }) {
  const lines = [
    "Module versions planned by `telo release`: `metadata.version`, each module's",
    "npm controller version and `pkg:npm` pin, its CHANGELOG and the ledger.",
    "**Merging publishes every module listed below** to the OCI registry.",
  ];

  for (const { vendor, plan } of vendors) {
    lines.push("", `## ${vendor}`, "", "| Module | Version | Level | Why |", "| --- | --- | --- | --- |");
    for (const m of plan.modules) {
      lines.push(`| \`${vendor}/${m.key}\` | ${m.from} → ${m.to} | ${m.level} | ${(m.reasons ?? []).join(", ")} |`);
    }
    if (!entries) continue;
    for (const m of plan.modules) {
      if (!(m.entries ?? []).length) continue;
      lines.push("", `### ${vendor}/${m.key} ${m.to}`);
      for (const kind of KIND_ORDER) {
        for (const entry of m.entries.filter((e) => e.kind === kind)) {
          // One line per entry: a body spanning several lines breaks the list, and
          // these are changelog sentences rather than prose blocks.
          const text = entry.body.replace(/\s+/g, " ").trim();
          const shown =
            entryLimit && text.length > entryLimit
              ? `${text.slice(0, entryLimit).trimEnd()}… _(trimmed — full text in the module's CHANGELOG)_`
              : text;
          lines.push(`- **${kind}** ${shown}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

if (vendors.length === 0) {
  process.stdout.write("No module versions to move.\n");
  process.exit(0);
}

// Degrade in stated stages rather than truncating mid-sentence: full body, then
// trimmed entries, then the version tables alone.
for (const attempt of [
  { entryLimit: null, entries: true },
  { entryLimit: MAX_ENTRY, entries: true },
  { entryLimit: null, entries: false },
]) {
  const body = render(attempt);
  if (body.length <= MAX_BODY) {
    process.stdout.write(body);
    process.exit(0);
  }
}
process.stdout.write(
  "The release plan is too large to render in a PR body. Run `node scripts/release.mjs status` on this branch.\n",
);
