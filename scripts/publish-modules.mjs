#!/usr/bin/env node
// Push connector module manifests (and the npm controller each names) to the OCI
// base under TELO_OCI_REGISTRY, one repo per module: `<base>/<vendor>/<module>`,
// e.g. oci://ghcr.io/telorun/aws/s3. That is the same destination `telo release`
// computes for a vendor workspace — `<its registry>/<directory name>` — which is
// what lets the ledger gate and the publish gate speak about the same artifact.
//
// SEPARATE FROM VERSIONING, deliberately. `telo release` owns module identity,
// ordering and drift; this only decides what to push and pushes it. A second
// implementation of the release planner here would drift from it silently.
//
// A module is pushed when EITHER gate fires:
//   (a) its own metadata.version moved in HEAD^..HEAD — the normal release path, a
//       local git check needing no registry round-trip; and
//   (b) its current metadata.version is not yet published at its OCI repo — a
//       per-version presence check that catches a newly added module whose version
//       was seeded outside this commit, and re-tries any version a prior run failed
//       to push. An unchanged, already-published version is never re-pushed, so an
//       ordinary main push (typo fix, docs edit) republishes nothing.
//
// Both gates are idempotent, which is what makes this safe on every push to main
// rather than only on a release commit: a failed push heals on the next one.
//
// Usage: node scripts/publish-modules.mjs
// Env:
//   TELO_OCI_REGISTRY  no default; e.g. oci://ghcr.io/telorun — unset skips the pass
//   TELO_BIN           telo CLI binary (default: `telo` on PATH)

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseIn, vendors } from "./release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TELO = process.env.TELO_BIN ?? "telo";

// stderr is piped, not inherited: execSync's default lets a child's stderr reach the
// parent's and leaves `err.stderr` unset, so a caller reporting a failure could only
// say "Command failed".
function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// metadata.version of the first YAML document, read from the file's content at a git
// ref. Scoped to everything before the first `---` and to the `metadata:` block so a
// nested Telo.Definition field named `version` can't match. Null when the file is
// absent at that ref (a newly added module) or declares no metadata.version.
function manifestVersionAt(ref, yamlPath) {
  let content;
  try {
    content = run(`git show ${ref}:${yamlPath}`);
  } catch {
    return null;
  }
  const docEnd = content.search(/^---\s*$/m);
  const firstDoc = docEnd === -1 ? content : content.slice(0, docEnd);
  const metaMatch = firstDoc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (!metaMatch) return null;
  const versionMatch = metaMatch[1].match(/^[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+)["']?[ \t]*$/m);
  return versionMatch ? versionMatch[1] : null;
}

// Versions already published at an OCI repo, newest first. A repo that does not exist
// yet lists as `[]` (exit 0); "module not found" (some transports, exit 1) is likewise
// a real "no versions". Any other failure throws, so a flaky or auth-broken query
// fails loudly instead of silently reading as "already published".
function ociVersions(dest) {
  let out;
  try {
    out = execFileSync(TELO, ["module", "versions", dest, "--json"], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
    if (/not found/i.test(text)) return [];
    throw err;
  }
  const parsed = JSON.parse(out.trim());
  if (!Array.isArray(parsed)) {
    throw new Error(`unexpected 'module versions' output for ${dest}: ${out.trim()}`);
  }
  return parsed;
}

// TELO_OCI_REGISTRY has no default: unset skips the pass entirely, so its presence is
// the gate and a fork or a local run never pushes to someone else's registry off
// ambient Docker credentials.
const ociRegistry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
if (!ociRegistry) {
  console.log("TELO_OCI_REGISTRY unset — skipping the module publish pass.");
  process.exit(0);
}

// The module set AND the order come from the release model (`telo release order`),
// so the import graph is never re-derived here: a dependency is listed before its
// dependents, which is what a relative sibling import needs to resolve at the
// destination.
const modules = [];
for (const vendor of vendors()) {
  for (const name of releaseIn(vendor, ["order"], { capture: true }).split("\n")) {
    const key = name.trim();
    if (!key) continue;
    const manifest = join(ROOT, vendor, key, "telo.yaml");
    if (existsSync(manifest)) {
      modules.push({
        path: `${vendor}/${key}`,
        manifest,
        destination: `${ociRegistry}/${vendor}/${key}`,
      });
    }
  }
}

const queued = new Set();

// (a) version-moved gate.
let diff = "";
try {
  diff = run("git diff --name-only HEAD^ HEAD");
} catch {
  console.log("No prior commit to diff against — version-move gate skipped (presence gate still runs).");
}
const changed = new Set(diff.split("\n").filter(Boolean));
for (const m of modules) {
  const rel = `${m.path}/telo.yaml`;
  if (!changed.has(rel)) continue;
  const before = manifestVersionAt("HEAD^", rel);
  const after = manifestVersionAt("HEAD", rel);
  if (!after) {
    console.log(`  skip ${rel}: no metadata.version`);
    continue;
  }
  if (before === after) {
    console.log(`  skip ${rel}: metadata.version unchanged (${after}) — presence gate still applies`);
    continue;
  }
  queued.add(m.path);
}

// Presence checks that could not ANSWER — a broken credential, an unreachable
// registry. Distinct from "no versions published", which is a real answer.
const unanswered = [];

// (b) version-absent gate, over every module not already queued by (a).
for (const m of modules) {
  if (queued.has(m.path)) continue;
  const version = manifestVersionAt("HEAD", `${m.path}/telo.yaml`);
  if (!version) continue;
  let published;
  try {
    published = ociVersions(m.destination);
  } catch (err) {
    // NOT skipped silently. `ociVersions` throws only when the registry could not
    // answer, and a check that could not answer must never read as "already
    // published" — this job is the only module publish path, so swallowing it
    // stops modules publishing indefinitely behind green CI.
    unanswered.push(`${m.path}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    continue;
  }
  if (!published.includes(version)) {
    console.log(
      `  queue ${m.path}: ${version} not yet published to OCI (have: ${published.join(", ") || "none"})`,
    );
    queued.add(m.path);
  }
}

if (unanswered.length > 0) {
  console.error(
    `\n${unanswered.length} module${unanswered.length === 1 ? "" : "s"} could not be checked ` +
      `against ${ociRegistry} — their publish state is UNKNOWN, not up to date:`,
  );
  for (const line of unanswered) console.error(`  ${line}`);
}

// `modules` is already in dependency order, so filtering preserves it.
const publishOrder = modules.filter((m) => queued.has(m.path));
if (publishOrder.length === 0) {
  if (unanswered.length > 0) {
    console.error("\nNothing was queued, but the registry could not be reached. Failing.");
    process.exit(1);
  }
  console.log("Every module manifest is already published at its current version — nothing to push.");
  process.exit(0);
}

console.log(`\nPushing ${publishOrder.length} module(s) to ${ociRegistry}:`);
for (const m of publishOrder) console.log(`  ${m.path} → ${m.destination}`);
console.log("");

// Controllers are NOT skipped: a module's npm package is on the module ledger (its
// version is the module's, written by `telo release apply`), so `telo publish` is
// what pushes that tarball — before the manifest naming it, and skipped when npm
// already has that exact version.
//
// Failures are collected rather than thrown so one module can't abort the rest; a
// failed push leaves its version absent from OCI, so gate (b) retries it.
const failures = [];
for (const m of publishOrder) {
  try {
    execFileSync(TELO, ["publish", m.destination, m.manifest], { stdio: "inherit", cwd: ROOT });
  } catch (err) {
    failures.push({ path: m.path, message: err instanceof Error ? err.message : String(err) });
    console.error(`\n  push failed for ${m.path} — continuing with remaining modules.`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} module push(es) failed:`);
  for (const f of failures) {
    console.error(`  ${f.path} → ${ociRegistry}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  process.exit(1);
}

// A successful push pass does not clear an unanswered presence check: the modules it
// could not reach were never evaluated, so their state is still unknown.
if (unanswered.length > 0) {
  console.error(
    `\nPushed what could be evaluated, but ${unanswered.length} presence check(s) never ` +
      `answered — see above. Failing so this does not read as a clean run.`,
  );
  process.exit(1);
}
