# Apify connector

Run [Apify](https://apify.com) actors from Telo manifests. This module is the
general-purpose core: a friendly `Http.Client` (`ApifyClient`) and operations
over the Apify API v2 that take any actor id. Built on the `http-client` module,
with no controller code.

For the most-used Store actors there are also **typed per-actor modules**,
`apify/<user>-<actor>`, generated from each actor's own input and output
schemas, so `telo check` validates the input you pass. See
[generated-actors.md](generated-actors.md).

Runnable examples, one actor per app, are in [`apify/examples/`](../../examples/).

## Import

```yaml
imports:
  Apify: oci://ghcr.io/telorun/apify/apify@0.1.0#sha256-…
```

Pin the digest with `telo upgrade`.

## Client

```yaml
kind: Apify.ApifyClient
metadata: { name: apify }
token: !cel "secrets.apifyToken"
# optional: baseUrl (default https://api.apify.com — a proxy or a stub),
#           timeout (default per-request timeout in ms)
```

The token comes from Apify Console → Settings → API & Integrations, and is sent
as `Authorization: Bearer <token>`. Every run is charged to that token's account.
`ApifyClient` *is* an `Http.Client`, so it fits every operation's `client` slot.

## Operations

Each operation is an Invocable with a `client` and returns the HTTP response
`{ status, headers, body }`. An HTTP failure raises `ERR_HTTP_STATUS`, carrying
Apify's error body, rather than returning it.

| Kind | Call | Inputs | `body` |
| --- | --- | --- | --- |
| `RunActorSync` | `POST /v2/acts/{actorId}/run-sync-get-dataset-items` | `actorId`, `input`, `build`, `timeout`, `memory`, `maxItems`, `maxTotalChargeUsd` | the run's dataset items |
| `RunActor` | `POST /v2/acts/{actorId}/runs` | the same, plus `waitForFinish` (0–60 s) | `{ data: <run> }` |
| `GetRun` | `GET /v2/actor-runs/{runId}` | `runId`, `waitForFinish` (0–60 s) | `{ data: <run> }` |
| `GetDatasetItems` | `GET /v2/datasets/{datasetId}/items` | `datasetId`, `offset`, `limit`, `clean`, `fields`, `omit`, `desc` | the items |
| `AbortRun` | `POST /v2/actor-runs/{runId}/abort` | `runId`, `gracefully` | `{ data: <run> }` |

- `actorId` is the actor's id or `<username>/<name>`. The `/` is rewritten to
  the `~` Apify's paths take, and `<username>~<name>` is accepted as is.
- `input` is the actor's input, sent as the JSON body. It defaults to `{}`.
- `timeout`, `memory`, `maxItems` and `maxTotalChargeUsd` may be omitted or set
  to `null`. Either way the actor's own setting applies, which lets a wrapping
  kind forward an unset option without inventing a default.
- **`RunActorSync`** waits for the run on Apify's side. Apify holds the
  request open for at most 300 seconds, and a longer run fails with HTTP 408.
  Its request timeout is 330 s, independent of the client's. A run that fails
  answers HTTP 400 and raises.
- **`RunActor` + `GetRun`** handle runs of any length. Start the run, then call
  `GetRun` with `waitForFinish: 60` in a loop until `status` is one of
  `SUCCEEDED`, `FAILED`, `TIMED-OUT` or `ABORTED`, and read
  `defaultDatasetId` with `GetDatasetItems`. The generated `Start` kinds do
  exactly this.

```yaml
kind: Apify.RunActorSync
metadata: { name: scrape }
client: !ref apify
---
kind: Run.Sequence
metadata: { name: main }
steps:
  - name: scrape
    invoke: !ref scrape
    inputs:
      actorId: apify/website-content-crawler
      input:
        startUrls: [{ url: "https://docs.apify.com" }]
        maxCrawlPages: 5
      maxTotalChargeUsd: 1
```

## Tests

- `tests/operations.yaml` checks what each operation puts on the wire against
  a stub of the Apify API (`tests/__fixtures__/apify-stub.yaml`): method, path,
  query, body and Bearer token. It also checks that a failed synchronous run
  raises.
- `tests/generated.yaml` exercises the per-actor template through a module
  generated from a fixture actor. It covers the sync `Run`, the async `Start`
  polling a run that stays RUNNING for its first 100 ms, a FAILED run raising
  `APIFY_RUN_NOT_SUCCEEDED`, and `telo check` rejecting an input field the
  actor does not declare.
