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

/** Sibling module manifests fetched from the registry via the published `telo`
 *  CLI. Each is copied into `<root>/modules/<module>/telo.yaml` so fixtures
 *  import it by relative path. Whichever npm controller a manifest declares is
 *  read off its own `pkg:npm/...` PURL (see `controllersFrom`) — nothing here
 *  restates a version by hand. `http-dispatch` is pure `Telo.Type` schemas and
 *  declares no controller at all, so it contributes no npm dependency. */
const OCI_MODULES = [
  {
    module: "http-dispatch",
    ref: "oci://ghcr.io/telorun/http-dispatch@0.8.0#sha256-m1FESVzKRwwVyMGkN1NTv0RPlE_u-RlbAPSBko34UTg",
  },
  {
    module: "javascript",
    ref: "oci://ghcr.io/telorun/javascript@0.7.0#sha256-aKzlX_nloiYROA85sfZEidy4irQCugNk-MvtyDyqYoY",
  },
  {
    module: "type",
    ref: "oci://ghcr.io/telorun/type@0.8.0#sha256-z56gxs4HbdWHlUWWvLRFFHPy5wX52SU5A1Fo61s20-g",
  },
] as const;

/** Every `pkg:npm/<name>@<version>` controller a fetched manifest declares.
 *  This is the manifest's OWN statement of which controller build pairs with
 *  it, so the fixture installs exactly that — matching the kernel's registry
 *  fast path by version, offline, with no hand-maintained mirror to drift. */
function controllersFrom(manifest: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, name, version] of manifest.matchAll(
    /pkg:npm\/(@?[^/@\s]+(?:\/[^@\s]+)?)@([^?#\s"']+)/g,
  )) {
    found[name] = version;
  }
  return found;
}

/** The kernel that actually resolves our manifest inside the container. It is
 *  read off the installed `telo` CLI's own `@telorun/kernel` dependency, so the
 *  container runs precisely the kernel that CLI ships rather than a pin someone
 *  has to remember to bump. That pin going stale is not a hypothetical: at
 *  kernel 0.52.0 the object form `x-telo-ref: {kind, use}` was silently skipped,
 *  so every handler arrived without an invoke/run method and all 12 E2E tests
 *  failed against manifests the rest of the repo had already validated. */
function resolveKernelVersion(): string {
  const cli = execFileSync("telo", ["--version"], { encoding: "utf-8" }).trim();
  const kernel = execFileSync(
    "npm",
    ["view", `@telorun/cli@${cli}`, "dependencies.@telorun/kernel"],
    { encoding: "utf-8" },
  ).trim();
  if (!kernel) {
    throw new Error(
      `Could not resolve the @telorun/kernel version behind telo CLI ${cli}. ` +
        `The E2E fixture needs it to install a kernel into the container.`,
    );
  }
  return kernel;
}

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
 *  `npm install` once to produce a fully-resolved, offline `node_modules`.
 *
 *  Manifests are fetched BEFORE the install because they are what says which
 *  controller versions to install — every dependency below is derived, none is
 *  restated by hand. */
async function buildPreparedRoot(): Promise<string> {
  const packDir = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-pack-"));
  const lambdaTarball = packLambda(packDir);

  const root = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-root-"));
  const siblingControllers = await copyModuleManifests(root);

  const deps: Record<string, string> = {
    "@telorun/lambda": `file:${lambdaTarball}`,
    "@telorun/kernel": resolveKernelVersion(),
    ...siblingControllers,
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

  await stageControllers(root, Object.keys(siblingControllers));

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
 *  the registry.
 *
 *  Returns the npm controllers the fetched sibling manifests declare, as an
 *  install-ready `{ name: version }` map. Lambda's own controller is excluded —
 *  it is installed from the locally packed tarball, not the registry. */
async function copyModuleManifests(root: string): Promise<Record<string, string>> {
  const stripLocalPath = (yaml: string) => yaml.replaceAll(/\?local_path=[^#"\s]+/g, "");

  const lambdaManifest = stripLocalPath(
    readFileSync(join(LAMBDA_MODULE_DIR, "telo.yaml"), "utf-8"),
  ).replace(/^(\s*HttpDispatch:\s*).*$/m, "$1../http-dispatch");
  const lambdaDest = join(root, "modules", "lambda");
  mkdirSync(lambdaDest, { recursive: true });
  writeFileSync(join(lambdaDest, "telo.yaml"), lambdaManifest);

  const controllers: Record<string, string> = {};
  for (const mod of OCI_MODULES) {
    const manifest = stripLocalPath(fetchModuleManifest(mod.ref));
    const dest = join(root, "modules", mod.module);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "telo.yaml"), manifest);
    Object.assign(controllers, controllersFrom(manifest));
  }
  return controllers;
}

/** Pre-places real copies of the module controllers (installed into the
 *  fixture-root `node_modules` above) under `.telo/npm/node_modules/` so the
 *  kernel's registry fast path finds the right-version package already on disk
 *  and skips installing. `@telorun/sdk` is left to the kernel's realm-collapse
 *  bootstrap, which resolves it offline from the fixture-root `node_modules`. */
async function stageControllers(root: string, siblings: string[]): Promise<void> {
  const stageRoot = join(root, ".telo", "npm", "node_modules");
  const controllers = ["@telorun/lambda", ...siblings];
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
