# Generated actor modules

Every actor listed in [`apify/actors.yaml`](../../actors.yaml) gets its own
module, `apify/<user>-<actor>/`, generated from the actor's default build by
[`scripts/apify/generate.mjs`](../../../scripts/apify/generate.mjs) and
published as `oci://ghcr.io/telorun/apify/<user>-<actor>`. Each module's
`docs/README.md` describes that actor's input, output and pricing.

## What a module contains

- **`Run`**: runs the actor and waits for its dataset items, over
  `Apify.RunActorSync`. Apify's synchronous limit applies: up to 5 minutes.
  Returns `{ items }`.
- **`Start`**: starts the run, long-polls it with `Apify.GetRun` until it
  finishes, and reads its dataset. Returns `{ run, items }`, and raises
  `APIFY_RUN_NOT_SUCCEEDED` (with the run as `data`) when the run ends
  `FAILED`, `TIMED-OUT` or `ABORTED`.
- **`ApifyClient`**: re-exported from the core module, so the actor module is
  the only import a consumer needs.

Both kinds take a `client` plus optional static run options (`timeout`,
`memory`, `maxItems`, `maxTotalChargeUsd`). Their call inputs are the actor's
own input, typed by two shapes declared once in the module:

- **`Input`**, from the actor's input schema. Apify's UI keys (`editor`,
  `prefill`, `sectionCaption`, …) are dropped; types, `required`, defaults,
  enums and bounds carry over. An object that declares its properties is
  **closed** (`telo check` rejects an unknown field) unless the actor marks it
  open. A field whose type is an object with no declared properties is free
  form. `isSecret` fields are marked `x-telo-sensitive` and lose their
  defaults. An actor with no input schema accepts any object.
- **`Item`**, from the build's dataset schema, when the actor publishes one
  (about a third do). Outputs are validated when a call returns, and actors
  often return more or less than they declare, so this shape is lenient. Every
  field admits null, `integer` is widened to `number`, nothing is required, and
  every object stays open. Undeclared fields are still readable.

## Versioning — the exception to `telo release`

A generated module's `metadata.version` **is** the build number of the actor
build it was generated from (e.g. `apify/web-scraper` build `3.0.25` →
module `3.0.25`), and both kinds run exactly that build (`build=3.0.25`). The
types in a given version therefore always match the code that runs.

`telo release` cannot express that, so generated modules are outside it.
`apify/telo-workspace.yaml` releases only the core `apify` module. The generator
writes generated versions directly; they need no release fragment, and
`scripts/publish-modules.mjs` pushes any generated version not yet in the
registry. It runs after every released module, so the core is always pushed
first.

Consequences:

- A module's `telo.yaml` is rewritten **only when the actor's build number
  changes**. That version is published once and never again, so a generator
  fix reaches an actor with its next build. `--force` regenerates in place for
  development; that output is not published until the build moves.
- Publishing rewrites the `../apify` import to the core version current at
  that moment. Each build is pinned to the core it was published with.
- Apify may delete old builds of an actor. A module version whose build is gone
  stops running and must be upgraded.

## The actor list

`apify/actors.yaml` maps `user/name` to an options object:

```yaml
actors:
  apify/web-scraper: { seeded: true }     # added by the seed script
  someone/handpicked-actor: {}            # added by hand
  someone/gone-actor: { seeded: true, deprecated: "2026-10-21: no longer available on Apify" }
```

- [`scripts/apify/seed.mjs`](../../../scripts/apify/seed.mjs) adds the top 100
  Store actors by total users and every actor published by Apify itself, marked
  `seeded: true`. It never removes an entry. Seeded entries that no longer
  qualify are listed as "Dropped out" in its report. Delete the entry to stop
  generating the actor, or remove `seeded: true` to keep it without the notice.
- **Deprecation:** when an actor is gone from Apify (404), marked deprecated
  there, or has no default build, the generator writes `deprecated:` with the
  date and reason and adds a banner to the module's docs. The module is kept.
  If the actor comes back, the flag is cleared.

## Running it

```bash
pnpm run apify:seed        # update apify/actors.yaml from the Store
pnpm run apify:generate    # (re)generate every listed module
node scripts/apify/generate.mjs --only apify/web-scraper   # one actor
pnpm run apify:fixture     # regenerate the test fixture after a template change
```

Both scripts use only public Apify endpoints. Set `APIFY_TOKEN` to raise the
rate limit. `--report <file>` writes the markdown summary used as the PR body.
Network errors, 429 and 5xx responses are retried. Any other failure is listed
in the report and fails the run once every actor has been tried, so a partial
refresh never looks complete.

**Weekly CI** (`.github/workflows/apify-actors.yml`, Mondays 04:00 UTC, also
runnable by hand) runs seed, generate and `telo check` over the Apify modules,
then opens or refreshes one pull request (`apify-actors/refresh`) whose body is
both reports. Merging it publishes the new builds on the next push to `main`.

After changing the template in `scripts/apify/render.mjs`, run
`pnpm run apify:fixture` and `telo ./apify/apify/tests/generated.yaml`. CI fails
when the checked-in fixture does not match the generator.
