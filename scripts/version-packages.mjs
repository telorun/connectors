#!/usr/bin/env node
// Run by `changesets/action` in the "Version Packages" step.
// Wraps `changeset version` and extends it for Telo connector modules:
//   - records each module's npm controller version BEFORE the bump
//   - runs `changeset version` (bumps workspace package.json files, writes npm CHANGELOGs)
//   - for each <vendor>/<module>/nodejs/package.json whose version changed, rewrites the
//     pkg:npm PURL in <vendor>/<module>/telo.yaml to match AND queues a changie fragment so the
//     module's own metadata.version bumps by the same level
//   - runs changie (batch + merge) so module manifest versions + CHANGELOGs are updated in
//     the SAME Version PR as the npm bumps.
//
// changie owns telo module manifest versions (metadata.version, published to the OCI registry);
// changesets owns the npm controller packages.
//
// Usage: node scripts/version-packages.mjs
// Env: CHANGIE_BIN overrides the `changie` binary path (passed through to changie-release).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseChangieProjects } from "./changie-release.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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

function runLive(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

function readPkgVersion(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function diffLevel(before, after) {
  if (!before || !after || before === after) return null;
  const a = before.split(".").map(Number);
  const b = after.split(".").map(Number);
  if (b[0] > a[0]) return "major";
  if (b[1] > a[1]) return "minor";
  if (b[2] > a[2]) return "patch";
  return null;
}

// changie kind whose `auto:` level matches an npm bump level (see .changie.yaml kinds).
const KIND_FOR_LEVEL = { major: "Changed", minor: "Added", patch: "Fixed" };

function rewritePurls(content, packageName, newVersion) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`(pkg:[^/]+/${escaped}@)[^?#\\s]+(\\?[^#\\s]*)?(#[^\\s]*)?`, "g"),
    (_, prefix, qs, frag) => `${prefix}${newVersion}${qs ?? ""}${frag ?? ""}`,
  );
}

/** Queue a changie fragment so `changie batch auto` bumps the module's metadata.version. */
function queueChangieFragment(moduleKey, level, pkgName, pkgVersion) {
  const projectDir = join(ROOT, ".changes", moduleKey);
  if (!existsSync(projectDir)) return false; // not a changie project (no metadata.version)
  const kind = KIND_FOR_LEVEL[level];
  const body = `Update controller ${pkgName} to ${pkgVersion}.`;
  const file = join(ROOT, ".changes", "unreleased", `auto-${moduleKey}-${pkgVersion}.yaml`);
  writeFileSync(file, `project: ${moduleKey}\nkind: ${kind}\nbody: ${body}\n`, "utf8");
  return true;
}

// Enumerate connector modules that ship an npm controller: <vendor>/<module>/nodejs/package.json.
// `key` is the module directory name (the changie project key); `manifestPath` its telo.yaml.
function moduleControllerDirs() {
  const out = [];
  for (const vendor of readdirSync(ROOT, { withFileTypes: true })) {
    if (!vendor.isDirectory() || SKIP_DIRS.has(vendor.name)) continue;
    const vendorDir = join(ROOT, vendor.name);
    for (const mod of readdirSync(vendorDir, { withFileTypes: true })) {
      if (!mod.isDirectory()) continue;
      const pkgPath = join(vendorDir, mod.name, "nodejs", "package.json");
      if (!existsSync(pkgPath)) continue;
      out.push({
        key: mod.name,
        pkgPath,
        manifestPath: join(vendorDir, mod.name, "telo.yaml"),
      });
    }
  }
  return out;
}

const moduleDirs = moduleControllerDirs();

// Snapshot module controller npm versions before changeset consumes the .md files.
const before = new Map();
for (const { key, pkgPath } of moduleDirs) {
  before.set(key, readPkgVersion(pkgPath));
}

// Standard changesets version step (npm packages).
runLive("pnpm changeset version");

// For each module whose npm controller version moved: sync its telo.yaml pkg:npm PURL and
// queue a changie fragment so its manifest version bumps by the same level.
let queued = 0;
for (const { key, pkgPath, manifestPath } of moduleDirs) {
  const after = readPkgVersion(pkgPath);
  const level = diffLevel(before.get(key), after);
  if (!level) continue;

  if (!existsSync(manifestPath)) {
    console.warn(`  ${key}: npm bumped to ${after} but telo.yaml not found — skipping`);
    continue;
  }

  const pkgName = JSON.parse(readFileSync(pkgPath, "utf8")).name;
  writeFileSync(manifestPath, rewritePurls(readFileSync(manifestPath, "utf8"), pkgName, after));

  if (queueChangieFragment(key, level, pkgName, after)) {
    queued++;
    console.log(`  ${key}: PURL ${pkgName}@* → @${after}, queued ${level} changie fragment`);
  } else {
    console.warn(`  ${key}: PURL synced but no changie project — manifest version not bumped`);
  }
}

console.log(`\nversion-packages: synced ${queued} module manifest(s) to their npm controller.`);

// Bump module manifest versions + CHANGELOGs from all pending changie fragments (the
// auto-queued ones above plus any hand-written module fragments) in this same Version PR.
releaseChangieProjects();
