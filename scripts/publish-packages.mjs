#!/usr/bin/env node
// Run by `changesets/action` as the `publish` script after the Version PR merges.
// 1. `changeset publish` — publishes npm packages whose versions moved and pushes git tags.
// 2. When TELO_OCI_REGISTRY is set, push <vendor>/<module>/telo.yaml to that OCI base via
//    `telo publish --skip-controllers`, one repo per module directory PATH relative to the repo
//    root (`<base>/<vendor>/<module>`, e.g. oci://ghcr.io/telorun/aws/s3).
//    A manifest is pushed when EITHER:
//      (a) its own metadata.version moved in HEAD^..HEAD — the normal release path; or
//      (b) its current metadata.version is not yet published at the OCI repo — a per-version
//          presence check. This catches a newly added module whose version was seeded in the
//          feature merge (outside the Version-PR commit this runs on) and re-tries any version
//          a prior release failed to push. An unchanged, already-published version is never
//          re-pushed, so a non-release main push (typo, schema edit) still won't republish.
//    Manifest-only modules (no controllers, no nodejs/package.json) publish on the same footing
//    as controller modules — PURLs were already synced by version-packages.mjs; this step only
//    runs static analysis and pushes the manifest. Unset TELO_OCI_REGISTRY skips the pass
//    entirely.
//
// Usage: node scripts/publish-packages.mjs
// Env:
//   TELO_OCI_REGISTRY  no default; e.g. oci://ghcr.io/telorun/aws — unset skips the OCI pass
//   TELO_BIN           telo CLI binary (default: `telo` — the published CLI on PATH)

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { orderByDependencies } from "./module-publish-order.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TELO = process.env.TELO_BIN ?? "telo";

// The OCI repo for a manifest is its directory path relative to the repo root
// (e.g. `aws/s3`), appended to the registry base — so with
// TELO_OCI_REGISTRY=oci://ghcr.io/telorun a module publishes to
// oci://ghcr.io/telorun/aws/s3. Identity is the ref, not metadata.namespace/name.
const moduleRepoPath = (manifest) => dirname(manifest).replace(ROOT + "/", "");

const SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".changes",
  ".changeset",
  ".telo",
  "node_modules",
  "scripts",
  "dist",
]);

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
}

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// Every connector module manifest: <vendor>/<module>/telo.yaml.
function moduleManifests() {
  const out = [];
  for (const vendor of readdirSync(ROOT, { withFileTypes: true })) {
    if (!vendor.isDirectory() || SKIP_DIRS.has(vendor.name)) continue;
    const vendorDir = join(ROOT, vendor.name);
    for (const mod of readdirSync(vendorDir, { withFileTypes: true })) {
      if (!mod.isDirectory()) continue;
      const manifest = join(vendorDir, mod.name, "telo.yaml");
      if (existsSync(manifest)) out.push(manifest);
    }
  }
  return out;
}

// metadata.version of the first YAML document, read from the file's content at a git ref.
// Scoped to everything before the first `---` and to the `metadata:` block so a nested
// Telo.Definition field named `version` can't match. Returns null when the file is absent at
// that ref (newly added module) or declares no metadata.version.
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

// Versions already published at an OCI repo, newest first. A repo that does not exist yet lists
// as `[]` (exit 0); "module not found" (exit 1) is likewise treated as "no versions". Any other
// failure throws so a flaky / auth-broken query fails the release loudly instead of silently
// skipping a module. Used for the per-version presence gate below.
function ociVersions(dest) {
  let out;
  try {
    out = execSync(`${TELO} module versions ${dest} --json`, {
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

runLive("pnpm changeset publish");

// Everything below is the OCI mirror pass. TELO_OCI_REGISTRY has no default: unset skips it
// entirely, so its presence is the gate and a fork or local run never pushes to someone else's
// registry off ambient Docker credentials. The repo is the module's directory name under the
// base — never `metadata.namespace`/`name`, since identity is the ref.
const ociRegistry = process.env.TELO_OCI_REGISTRY?.replace(/\/+$/, "");
if (!ociRegistry) {
  console.log("\nTELO_OCI_REGISTRY unset — skipping the OCI publish pass.");
  process.exit(0);
}

const allManifests = moduleManifests();
const relManifests = new Set(allManifests.map((m) => m.replace(ROOT + "/", "")));
const queued = new Set();

// (a) version-moved gate.
let diff = "";
try {
  diff = run("git diff --name-only HEAD^ HEAD");
} catch {
  console.log("No prior commit to diff against — version-move gate skipped (presence gate still runs).");
}
for (const f of diff.split("\n").filter((p) => relManifests.has(p))) {
  const before = manifestVersionAt("HEAD^", f);
  const after = manifestVersionAt("HEAD", f);
  if (!after) {
    console.log(`  skip ${f}: no metadata.version`);
    continue;
  }
  if (before === after) {
    console.log(`  skip ${f}: metadata.version unchanged (${after}) — presence gate still applies`);
    continue;
  }
  const abs = join(ROOT, f);
  if (existsSync(abs)) queued.add(abs);
}

// (b) version-absent gate, over every module manifest not already queued by (a).
for (const abs of allManifests) {
  if (queued.has(abs)) continue;
  const rel = abs.replace(ROOT + "/", "");
  const version = manifestVersionAt("HEAD", rel);
  if (!version) continue;
  const dest = `${ociRegistry}/${moduleRepoPath(abs)}`;
  let published;
  try {
    published = ociVersions(dest);
  } catch (err) {
    console.error(
      `  presence check failed for ${rel} — skipping: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
    continue;
  }
  if (!published.includes(version)) {
    console.log(`  queue ${rel}: ${version} not yet published to OCI (have: ${published.join(", ") || "none"})`);
    queued.add(abs);
  }
}

const manifests = [...queued];
if (manifests.length === 0) {
  console.log("Every module manifest is already published at its current version — nothing to push.");
  process.exit(0);
}

const publishOrder = orderByDependencies(manifests);

// One push pass over the ordered manifests. `destinationFor` maps a manifest to the `telo
// publish` destination positional; relative sibling imports canonicalize to that same OCI base
// and resolve there. Failures are collected rather than thrown so one module can't abort the
// rest of the release; a failed push leaves its version absent from OCI, so the presence gate
// retries it next release.
function pushAll(label, destinationFor) {
  console.log(`\nPushing ${publishOrder.length} module manifest(s) to ${label}:`);
  for (const m of publishOrder) console.log(`  ${m.replace(ROOT + "/", "")}`);
  console.log("");

  const failed = [];
  for (const m of publishOrder) {
    const rel = m.replace(ROOT + "/", "");
    const destination = destinationFor(m);
    try {
      runLive(`${TELO} publish --skip-controllers ${destination ? `${destination} ` : ""}${m}`);
    } catch (err) {
      failed.push({ path: rel, target: label, message: err instanceof Error ? err.message : String(err) });
      console.error(`\n  push to ${label} failed for ${rel} — continuing with remaining manifests.`);
    }
  }
  return failed;
}

const failures = pushAll(ociRegistry, (m) => `${ociRegistry}/${moduleRepoPath(m)}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest push(es) failed:`);
  for (const f of failures) {
    console.error(`  ${f.path} → ${f.target}`);
    if (f.message) console.error(`    ${f.message.split("\n")[0]}`);
  }
  process.exit(1);
}
