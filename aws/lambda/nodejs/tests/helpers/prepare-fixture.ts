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

/** Sibling modules the fixtures import, by digest-pinned OCI ref. The kernel
 *  resolves these itself on cold boot inside the container (which has a
 *  network, same as CI), so nothing here is vendored: `run` ships its
 *  controller as a `pkg:telo/local/js` bundle inside its own OCI layers, which
 *  a copied `telo.yaml` alone would leave behind. Only `@telorun/lambda` — the
 *  package under test, unpublished at this version — is sourced locally. */
const OCI_MODULES = {
  run: "oci://ghcr.io/telorun/run@0.26.0#sha256-ZhW56yiMCImqBh0wJ4mVaUvh5WuUVIaWErASFx--wCY",
  type: "oci://ghcr.io/telorun/type@0.8.0#sha256-z56gxs4HbdWHlUWWvLRFFHPy5wX52SU5A1Fo61s20-g",
} as const;

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

/** `source:` for each module's import in the fixture manifests. Lambda is the
 *  copied local module directory; the siblings are the OCI refs above. */
export const MODULE_SOURCES = {
  lambda: "./modules/lambda",
  run: OCI_MODULES.run,
  type: OCI_MODULES.type,
} as const;

/** Cached across all fixtures in a vitest run — packing + npm-installing is
 *  the slowest part. Each fixture clones this tree before layering its own
 *  telo.yaml + bootstrap on top. */
let preparedRoot: Promise<string> | null = null;

/** Packs the LOCAL `@telorun/lambda` controller into a tarball so the fixture
 *  runs the code about to ship (not a published version — npm has nothing at
 *  this version, by design). `pnpm pack` ships only files listed in
 *  package.json `files` (i.e. `dist/`), so the package must be built first. */
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

/** Lays the local Lambda module down at `<root>/modules/lambda`: its manifest
 *  verbatim (the `?local_path=./nodejs` qualifier KEPT, so the kernel resolves
 *  the controller from the copied package rather than from npm, which has no
 *  0.10.0) beside the packed package itself at `modules/lambda/nodejs`.
 *
 *  The controller's own runtime deps are installed there because `local_path`
 *  imports the entry straight off disk — its `node_modules` walk-up has to
 *  find `@sinclair/typebox` and friends. `--omit=dev` keeps it to what the
 *  published package declares. */
function stageLambdaModule(root: string, tarball: string): void {
  const moduleDir = join(root, "modules", "lambda");
  const pkgDir = join(moduleDir, "nodejs");
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(moduleDir, "telo.yaml"),
    readFileSync(join(LAMBDA_MODULE_DIR, "telo.yaml"), "utf-8"),
  );

  // `pnpm pack` tarballs are rooted at `package/`; strip it so the package
  // lands directly at `modules/lambda/nodejs`.
  execFileSync("tar", ["xzf", tarball, "-C", pkgDir, "--strip-components=1"]);
  execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--silent"], {
    cwd: pkgDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Builds the tree every fixture clones: the local Lambda module staged under
 *  `modules/`, plus a `node_modules` holding the kernel the bootstraps import.
 *  Sibling modules and their controllers are left to the kernel's own resolver
 *  on cold boot — the container has a network, and its npm install root is
 *  keyed differently from the host's, so pre-staging them here would be
 *  ignored anyway. */
async function buildPreparedRoot(): Promise<string> {
  const packDir = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-pack-"));
  const lambdaTarball = packLambda(packDir);

  const root = mkdtempSync(join(tmpdir(), "telo-lambda-e2e-root-"));
  stageLambdaModule(root, lambdaTarball);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "lambda-e2e-fixture-root",
        version: "0.0.0",
        private: true,
        dependencies: { "@telorun/kernel": resolveKernelVersion() },
      },
      null,
      2,
    ),
  );
  execFileSync("npm", ["install", "--no-package-lock", "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });

  return root;
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
 *  carries the staged Lambda module and the kernel), writes the fixture's
 *  telo.yaml, and copies the right bootstrap into place. The container resolves
 *  the sibling modules and their controllers on cold boot, writing into the
 *  bind-mounted `.telo/`. */
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
