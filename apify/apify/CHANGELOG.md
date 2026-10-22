# Changelog

## 0.1.0 - 2026-10-22
### Added
* New `apify/apify` module: `ApifyClient`, an `Http.Client` preconfigured with an Apify API token, and the operations `RunActorSync` (run an actor and return its dataset items, up to Apify's five-minute limit), `RunActor` (start a run), `GetRun` (read a run, long-polling up to 60 s), `GetDatasetItems` and `AbortRun`. The run options `timeout`, `memory`, `maxItems` and `maxTotalChargeUsd` accept null as "use the actor's default". The generated per-actor modules (`apify/<user>-<actor>`) are built on it.
