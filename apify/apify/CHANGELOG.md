# Changelog

## 0.2.0 - 2026-11-28
### Added
* Upgraded standard-module imports to their latest published versions.
### Fixed
* `RunActorSync` and `RunActor` now pass `telo check` on telo 0.141, which stopped narrowing a nullable `timeout`/`memory`/`maxItems`/`maxTotalChargeUsd` after its null guard.

## 0.1.0 - 2026-10-22
### Added
* New `apify/apify` module: `ApifyClient`, an `Http.Client` preconfigured with an Apify API token, and the operations `RunActorSync` (run an actor and return its dataset items, up to Apify's five-minute limit), `RunActor` (start a run), `GetRun` (read a run, long-polling up to 60 s), `GetDatasetItems` and `AbortRun`. The run options `timeout`, `memory`, `maxItems` and `maxTotalChargeUsd` accept null as "use the actor's default". The generated per-actor modules (`apify/<user>-<actor>`) are built on it.
