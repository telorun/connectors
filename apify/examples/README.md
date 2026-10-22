# Apify examples

Five small applications. Each runs one Apify actor once and prints the results
to the console, one JSON line per item.

| File | Actor | How | Cost |
| --- | --- | --- | --- |
| [crawl-page.yaml](crawl-page.yaml) | `apify/website-content-crawler` | typed `Run` (sync) | free actor, platform usage only |
| [google-search.yaml](google-search.yaml) | `apify/google-search-scraper` | typed `Run` (sync) | pay per result page, capped at $0.05 |
| [google-maps-places.yaml](google-maps-places.yaml) | `compass/crawler-google-places` | typed `Start` (async, polls) | pay per place, capped at $0.10 |
| [youtube-search.yaml](youtube-search.yaml) | `streamers/youtube-scraper` | typed `Start` (async, polls) | pay per video, capped at $0.05 |
| [any-actor.yaml](any-actor.yaml) | `apify/instagram-scraper` | core `Apify.RunActorSync`, any actor by id, untyped | pay per result, capped at $0.05 |

The typed examples import a generated actor module, so `telo check` validates
the input against the actor's own schema. `any-actor.yaml` shows the fallback
for an actor that has no generated module: the core operation takes any
`actorId` and an untyped `input`.

## Run

```bash
cp .env.example .env.local      # gitignored; put your Apify API token in it
telo crawl-page.yaml
```

Run each example from this directory. Every run is charged to the Apify account
whose token you use. The caps above are passed as `maxTotalChargeUsd`, which
Apify enforces for pay-per-event actors.

The examples import the modules in this repository by relative path. In your own
application, import the published module instead, for example:

```yaml
imports:
  Crawler: oci://ghcr.io/telorun/apify/apify-website-content-crawler@<build>#sha256-…
```

and pin it with `telo upgrade`.
