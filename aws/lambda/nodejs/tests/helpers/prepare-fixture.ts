import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The connector package under test — `aws/lambda/nodejs` — and its module
 *  directory (the `telo.yaml` beside it). This is the ONLY code sourced
 *  locally; everything the kernel and sibling modules need is pulled from the
 *  published registry, so the connectors repo never references Telo kernel
 *  source. */
const LAMBDA_PKG_DIR = resolve(__dirname, "..", "..");
const LAMBDA_MODULE_DIR = resolve(LAMBDA_PKG_DIR, "..");

/** Published npm packages installed into the fixture root. `@telorun/kernel`
 *  drags its own published dependency tree (`@telorun/sdk`, analyzer, glob,
 *  templating, cel-js, typebox, …) in transitively, so the bootstrap's
 *  `import { Kernel } from "@telorun/kernel"` resolves from the fixture-root
 *  `node_modules` without packing any workspace source. The sibling module
 *  controllers are pinned to the npm versions their published `telo.yaml`
 *  PURLs reference, so the kernel's registry fast path matches them offline. */
const PUBLISHED_NPM: Record<string, string> = {
  "@telorun/kernel": "0.52.0",
  "@telorun/http-dispatch": "0.4.1",
  "@telorun/javascript": "0.4.1",
  "@telorun/type": "0.5.0",
};

/** Sibling module manifests fetched from the registry via the published `telo`
 *  CLI. Each is copied into `<root>/modules/<module>/telo.yaml` so fixtures
 *  import it by relative path; the controllers are the `PUBLISHED_NPM` installs
 *  above. `npmPackage` is the controller name staged for the registry fast
 *  path. */
const OCI_MODULES = [
  {
    module: "http-dispatch",
    npmPackage: "@telorun/http-dispatch",
    ref: "oci://ghcr.io/telorun/http-dispatch@0.8.0#sha256-m1FESVzKRwwVyMGkN1NTv0RPlE_u-RlbAPSBko34UTg",
  },
  {
    module: "javascript",
    npmPackage: "@telorun/javascript",
    ref: "oci://ghcr.io/telorun/javascript@0.7.0#sha256-aKzlX_nloiYROA85sfZEidy4irQCugNk-MvtyDyqYoY",
  },
  {
    module: "type",
    npmPackage: "@telorun/type",
    ref: "oci://ghcr.io/telorun/type@0.8.0#sha256-z56gxs4HbdWHlUWWvLRFFHPy5wX52SU5A1Fo61s20-g",
  },
] as const;

/** Fixture-root-relative `source:` for each module's `Telo.Import`. Consumed by
 *  the manifest helpers so import paths and the copied tree stay in lockstep.
 *  All three resolve to a copied `modules/<name>/` directory. */
export const MODULE_SOURCES = {
  lambda: "./modules/lambda",
  javascript: "./modules/javascript",
  type: "./modules/type",
} as const;

/** Cached across all fixtures in a vitest run — packing + npm-installing is
 *  the slowest part. Each fixture clones this tree before layering its own
 *  telo.yaml + bootstrap on top. */
let preparedRoot: Promise<string> | null = null;

/** Packs the LOCAL `@telorun/lambda` controller into a tarball so the fixture
 *  root installs the code about to ship (not a published version). `pnpm pack`
 *  ships only files listed in package.json `files` (i.e. `dist/`), so the
 *  package must be built first. */
function packLambda(packDir: string): string {
  const out = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", packDir, "--config.ignore-scripts=true"],
    { cwd: LAMBDA_PKG_DIR, encoding: "utf-8" },
  );
  const tarballPath = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()!;
  if (!existsSync(tarballPath)) {
    throw new Error(
      `pnpm pack didn't produce a tarball for @telorun/lambda at ${tarballPath}. Output:\n${out}`,
    );
  }
  return tarballPath;
}

/** Fetches a module's published `telo.yaml` via the `telo` CLI. Kept behind a
 *  helper so the offline-fixture flow has a single registry read path. */
function fetchModuleManifest(ref: string): string {
  return execFileSync("telo", ["module", "manifest", ref], { encoding: "utf-8" });
}

/** Writes a synthetic `package.json` that installs the packed local Lambda
 *  controller alongside the published runtime + sibling controllers, then runs
 *  `npm install` once to produce a fully-resolved, offline `node_modules`. */
async function buildPreparedRoot(): Promise<string> {
  const packDir = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-pack-"));
  const lambdaTarball = packLambda(packDir);

  const root = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-root-"));
  const deps: Record<string, string> = {
    "@telorun/lambda": `file:${lambdaTarball}`,
    ...PUBLISHED_NPM,
  };
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "lambda-e2e-fixture-root", version: "0.0.0", private: true, dependencies: deps },
      null,
      2,
    ),
  );

  execFileSync("npm", ["install", "--no-package-lock", "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });

  await copyModuleManifests(root);
  await stageControllers(root);

  return root;
}

/** Places each module's `telo.yaml` under `<root>/modules/<name>/` so fixtures
 *  import it by relative path, stripping the `?local_path=` qualifier off every
 *  controller PURL so the kernel resolves it as a `kind: "registry"` spec —
 *  matched by installed *version* (staged below) rather than a `file:` path,
 *  which is what survives the host→container bind-mount with no boot-time
 *  install. Lambda's own manifest is the local copy (rewriting its
 *  `HttpDispatch` OCI import to the co-copied `../http-dispatch` sibling so the
 *  offline container never reaches the network); the siblings are fetched from
 *  the registry. */
async function copyModuleManifests(root: string): Promise<void> {
  const stripLocalPath = (yaml: string) => yaml.replaceAll(/\?local_path=[^#"\s]+/g, "");

  const lambdaManifest = stripLocalPath(
    readFileSync(join(LAMBDA_MODULE_DIR, "telo.yaml"), "utf-8"),
  ).replace(/^(\s*HttpDispatch:\s*).*$/m, "$1../http-dispatch");
  const lambdaDest = join(root, "modules", "lambda");
  mkdirSync(lambdaDest, { recursive: true });
  writeFileSync(join(lambdaDest, "telo.yaml"), lambdaManifest);

  for (const mod of OCI_MODULES) {
    const manifest = stripLocalPath(fetchModuleManifest(mod.ref));
    const dest = join(root, "modules", mod.module);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "telo.yaml"), manifest);
  }
}

/** Pre-places real copies of the module controllers (installed into the
 *  fixture-root `node_modules` above) under `.telo/npm/node_modules/` so the
 *  kernel's registry fast path finds the right-version package already on disk
 *  and skips installing. `@telorun/sdk` is left to the kernel's realm-collapse
 *  bootstrap, which resolves it offline from the fixture-root `node_modules`. */
async function stageControllers(root: string): Promise<void> {
  const stageRoot = join(root, ".telo", "npm", "node_modules");
  const controllers = ["@telorun/lambda", ...OCI_MODULES.map((m) => m.npmPackage)];
  for (const pkg of controllers) {
    const installed = join(root, "node_modules", pkg);
    const version = JSON.parse(readFileSync(join(installed, "package.json"), "utf-8")).version;
    if (!version) {
      throw new Error(`Installed controller ${pkg} is missing from ${installed}.`);
    }
    await cp(installed, join(stageRoot, ...pkg.split("/")), { recursive: true });
  }
}

/** Returns the prepared root path. Builds it on first call; subsequent calls
 *  resolve to the same path. */
export function getPreparedRoot(): Promise<string> {
  if (!preparedRoot) preparedRoot = buildPreparedRoot();
  return preparedRoot;
}

export interface FixtureSpec {
  /** Suffix for the fixture's temp-dir name. */
  name: string;
  /** Contents of the user's `Telo.Application` telo.yaml. */
  telo: string;
  /** Picks which bootstrap is materialised — managed → `index.mjs`,
   *  custom → `bootstrap` (executable). Both are copied verbatim from the
   *  local `@telorun/lambda` package. */
  mode: "managed" | "custom";
}

export interface Fixture {
  /** Absolute path to the fixture root — bind-mount this as `/var/task`. */
  dir: string;
  /** Removes the fixture dir. */
  cleanup: () => void;
}

/** Materialises a per-test fixture: clones the prepared root (which already
 *  carries the copied module manifests and the staged `.telo/npm/` controllers),
 *  writes the fixture's telo.yaml, and copies the right bootstrap into place.
 *  No `telo install` is needed at boot — every controller is pre-staged at its
 *  installed version, so the offline AWS Lambda container resolves them without
 *  a network. */
export async function buildFixture(spec: FixtureSpec): Promise<Fixture> {
  const root = await getPreparedRoot();
  const dir = mkdtempSync(join(tmpdir(), `telo-lambda-e2e-${spec.name}-`));

  // Real file copies (not symlinks) so the bind-mount sees the full tree.
  for (const entry of readdirSync(root)) {
    await cp(join(root, entry), join(dir, entry), { recursive: true });
  }

  writeFileSync(join(dir, "telo.yaml"), spec.telo);

  if (spec.mode === "managed") {
    const src = await readFile(join(LAMBDA_PKG_DIR, "managed.mjs"), "utf-8");
    writeFileSync(join(dir, "index.mjs"), src);
  } else {
    const src = await readFile(join(LAMBDA_PKG_DIR, "custom.mjs"), "utf-8");
    writeFileSync(join(dir, "bootstrap"), src, { mode: 0o755 });
  }

  return {
    dir,
    cleanup: () => {
      // The container ran as root and chowned bind-mounted files; tolerate
      // EACCES from rmSync — these are temp dirs the OS will GC anyway.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EACCES") throw err;
      }
    },
  };
}
