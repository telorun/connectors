#!/usr/bin/env node
// Run a `telo release` subcommand across every vendor workspace.
//
// ONE WORKSPACE PER VENDOR, deliberately. `telo release` derives a module's publish
// destination as `<registry>/<directory name>`, and its ledger records ONE registry
// base for the whole workspace — so a single repo-root anchor would publish
// `aws/s3` as `oci://ghcr.io/telorun/s3`, flattening refs consumers already pin.
// Anchoring per vendor (`aws/telo-workspace.yaml`, …) keeps the base
// `oci://ghcr.io/telorun/<vendor>` and the published ref `…/aws/s3`, and gives each
// vendor its own `.changes/ledger.yaml` + `.changes/pending/`.
//
// A vendor is any top-level directory holding a `telo-workspace.yaml`. Nothing
// registers the set — adding a vendor is adding that file.
//
// Usage:
//   node scripts/release.mjs status [--base <ref>]
//   node scripts/release.mjs check|order|apply|verify [...args]
//   node scripts/release.mjs status --json <dir>   # one <vendor>.json plan per vendor
// Env:
//   TELO_OCI_REGISTRY  the base vendors hang off, e.g. oci://ghcr.io/telorun. Each
//                      vendor resolves `<base>/<vendor>`; unset falls back to the
//                      base each ledger already records.
//   TELO_BIN           telo CLI binary (default: `telo` on PATH)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TELO = process.env.TELO_BIN ?? "telo";

/** Top-level directories that anchor a release workspace, in a stable order. */
export function vendors() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .filter((name) => existsSync(join(ROOT, name, "telo-workspace.yaml")))
    .sort();
}

/** The registry base for one vendor, or undefined to let the ledger's own base win. */
export function registryFor(vendor) {
  const base = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
  return base ? `${base}/${vendor}` : undefined;
}

/** Run `telo release <args>` inside a vendor workspace. `capture` returns stdout;
 *  otherwise the child's output is inherited so a CI log reads as one stream. */
export function releaseIn(vendor, args, { capture = false } = {}) {
  const registry = registryFor(vendor);
  return execFileSync(TELO, ["release", ...args, ...(registry ? ["--registry", registry] : [])], {
    cwd: join(ROOT, vendor),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

const [subcommand, ...rest] = process.argv.slice(2);
if (!subcommand) {
  console.error("usage: node scripts/release.mjs <status|check|order|apply|verify> [...args]");
  process.exit(2);
}

// `status --json <dir>` writes one plan file per vendor, for the Version PR body.
// The plans MUST be captured before `apply` consumes the fragments the changelog
// entries come from.
const jsonAt = rest.indexOf("--json");
const outDir = jsonAt === -1 ? null : rest[jsonAt + 1];
const args = jsonAt === -1 ? rest : rest.filter((_, i) => i !== jsonAt && i !== jsonAt + 1);
if (outDir) mkdirSync(resolve(ROOT, outDir), { recursive: true });

// A vendor whose command fails does not stop the others: a broken plan in one
// vendor must not hide the state of the rest. The exit code is the aggregate.
let failed = 0;
for (const vendor of vendors()) {
  if (!outDir) console.log(`\n== ${vendor}`);
  try {
    if (outDir) {
      const plan = releaseIn(vendor, [subcommand, "-o", "json", ...args], { capture: true });
      writeFileSync(join(resolve(ROOT, outDir), `${vendor}.json`), plan);
    } else {
      releaseIn(vendor, [subcommand, ...args]);
    }
  } catch (err) {
    failed = 1;
    console.error(`  ${vendor}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}
process.exit(failed);
