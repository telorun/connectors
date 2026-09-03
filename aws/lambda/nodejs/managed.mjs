// Shipped bootstrap for AWS Lambda managed runtimes (nodejs24.x / nodejs20.x).
// Copy verbatim into your Lambda artifact root, e.g.:
//   cp node_modules/@telorun/lambda/managed.mjs ./index.mjs
// then point AWS at `index.handler`.
//
// AWS owns the outer loop: it calls `handler(event, context)` per invocation,
// we forward to `kernel.invoke("aws/lambda#Function", "Main", { event, context })`.
// The Function classifies the event by shape and dispatches to the matching
// concrete handler (HttpApi, Sqs, Direct, ...).
//
// Conventional Function name is `Main`; if your manifest names it differently,
// copy this file and edit the literal below.

import { dirname, join, resolve } from "node:path";

import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  resolveCacheRoot,
} from "@telorun/kernel";

const ENTRY = "./telo.yaml";
const cacheRoot = resolveCacheRoot(ENTRY);

// `LocalManifestCacheSource` serves the manifests `telo install` vendored into
// `.telo/manifests` (module `telo.yaml`s AND their controller layers), ahead of
// the registry/HTTP sources. Without it a packaged artifact re-fetches every
// `oci://` import from the network on each cold start — which in a VPC with no
// egress means it never boots at all.
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
await kernel.boot();
process.once("SIGTERM", () => kernel.teardown());

export const handler = (event, context) =>
  kernel.invoke({ kind: "aws/lambda#Function", name: "Main" }, { event, context });
