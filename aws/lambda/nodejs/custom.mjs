#!/usr/bin/env node
// Shipped bootstrap for AWS Lambda custom runtimes (provided.al2023 or
// container images). Copy verbatim into your Lambda artifact root, e.g.:
//   cp node_modules/@telorun/lambda/custom.mjs ./bootstrap && chmod +x ./bootstrap
//
// AWS sets $AWS_LAMBDA_RUNTIME_API; the Lambda.Function controller observes
// it inside `run()` and starts the poll loop against the AWS Runtime API.
// `kernel.start()` blocks until SIGTERM releases the Function's kernel hold.

import { dirname, join, resolve } from "node:path";

import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  resolveCacheRoot,
} from "@telorun/kernel";

const ENTRY = "./telo.yaml";
const cacheRoot = resolveCacheRoot(ENTRY);

// See managed.mjs: serves `telo install`'s vendored manifests so a packaged
// artifact boots without reaching the registry.
const kernel = new Kernel({
  sources: [
    new LocalFileSource(),
    new LocalManifestCacheSource(
      dirname(resolve(ENTRY)),
      undefined,
      cacheRoot ? join(cacheRoot, "manifests") : undefined,
    ),
  ],
});
await kernel.load(ENTRY);
process.once("SIGTERM", () => kernel.teardown());
await kernel.start();
