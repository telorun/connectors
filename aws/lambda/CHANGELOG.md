# Changelog

## 0.11.0 - 2026-09-03
### Added
* Upgrade the `http-dispatch` import to 0.12.0. Its `content` maps (on `Outcomes/$defs/Returns` and `Outcomes/$defs/Catches`, which `Lambda.HttpApi` draws its `returns` / `catches` schemas from) now carry `propertyNames` media-type hints, so an editor suggests `application/json` and friends without closing the set to a vendor content type.
* Boot packaged artifacts hermetically: `managed.mjs` and `custom.mjs` now wire the kernel's `LocalManifestCacheSource` over `.telo/manifests` (honouring `TELO_CACHE_DIR`), so a `telo install`-packaged Lambda resolves its `oci://` imports from the artifact instead of re-fetching them from ghcr.io on every cold start — which never completed at all in a VPC without egress. Also declare the CEL evaluation context on Lambda.Direct and Lambda.Sqs — `inputs` (and Direct's `returns` / `catches`) now advertise the `event` / `context` (plus `result` / `error`) scope the controllers actually expand with, so `!cel "event.Records"` type-checks instead of failing analysis as an unknown identifier.

## 0.10.0 - 2026-08-21
### Added
* Declare `x-telo-ref` targets in object form with an explicit `use:` — handler slots are `kind: Telo.Executable, use: trigger.inbound` (collapsing the `anyOf: [Telo.Invocable, Telo.Runnable]` pair), and `Lambda.Function.handlers` is `kind: Self.Handler, use: dependency`. Replaces the deprecated `<namespace>/<module>#<Kind>` form and pins the http-dispatch import to the OCI ref `0.11.0`.

## 0.9.1 - 2026-07-24
### Fixed
* Update controller @telorun/lambda to 0.6.1.## 0.9.0 - 2026-07-19
### Added
* Update controller @telorun/lambda to 0.6.0.## 0.8.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.7.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.6.1 - 2026-06-28
### Fixed
* Update controller @telorun/lambda to 0.5.1.## 0.6.0 - 2026-06-07
### Added
* Module `description` so registry search and the MCP `search_modules` tool surface the module's purpose.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/lambda to 0.5.0.## 0.4.1
