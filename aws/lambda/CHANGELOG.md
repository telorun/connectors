# Changelog

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
