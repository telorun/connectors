# Claude — building Telo connectors

This repo contains **Telo connector libraries** that wrap an external service (an API) as typed Telo resource kinds, so a user's `Telo.Application` can compose them
with `imports:` + `!ref`. This file is the authoritative guide for authoring Telo manifests here.

## What Telo is

Telo is a **declarative runtime**. A manifest is a YAML file describing desired
state; the kernel resolves resources and runs one **controller** per resource
kind. You do not write imperative code — you declare resource kinds and wire them
together with **references** (`!ref`) and **CEL expressions** (`!cel`). The kernel
resolves dependencies through a multi-pass init loop, evaluates CEL, and drives
each resource through its capability lifecycle.

Connectors in this repo are almost always **pure manifest** (no controller
code): they specialize and compose kinds from the standard modules (chiefly
`ghcr.io/telorun/http-client`) rather than shipping a runtime. Reach for a
TypeScript controller only when the standard modules genuinely can't express the
behavior.

## Manifest file structure

A manifest file is one or more `---`-separated YAML documents. Every document has
a top-level `kind:` and a `metadata:` block (`name`, plus `version` on the root
doc). **Resource fields sit at the document top level, beside `kind` and
`metadata` — there is NO `spec:`, `telo:`, or wrapper.**

The FIRST document of every file is exactly ONE of:

- `kind: Telo.Application` — a runnable entry point (declares `targets`, `ports`,
  lifecycle). Run directly with the `telo` CLI; **never** imported.
- `kind: Telo.Library` — an importable unit of kinds / definitions / instances
  (declares `exports`). Imported by others; **never** run directly. Everything in
  this repo is a Library.

Other built-in kinds you author inside a module:

- `Telo.Definition` — register a new resource kind (a JSON-Schema `schema:` plus
  either a `controllers:` locator or a template/inheritance body).
- `Telo.Abstract` — declare a non-instantiable contract others `extends`. Use it
  only when there is no default implementation and you want to force implementers.

Capabilities a kind can have (the lifecycle role):

- `Telo.Service` — `init()` + optional `teardown()`; long-lived servers/pools.
- `Telo.Runnable` — `run()`; one-shot tasks.
- `Telo.Invocable` — `invoke(inputs)`; request handlers, operations.
- `Telo.Provider` — `provide()` a value; config/secret/value sources (an
  `Http.Client` is a Provider).
- `Telo.Mount` — mounted into a Service (e.g. HTTP APIs).
- `Telo.Type` — pure schema, no runtime instance.

## Application / Library fields

`metadata.name` is kebab-case and becomes the module's **kind prefix**.
`metadata.version` is a semver string, required on the root doc.
`metadata.repository` points to this repository url `https://github.com/telorun/connectors`.

- `imports:` — a NAME-KEYED MAP: PascalCase alias → source. **OCI is the only
  form**: `oci://ghcr.io/telorun/<name>@VERSION#<digest>` — an EXACT version
  (never `@latest` or a range) pinned by a `sha256-…` integrity digest, e.g.

  ```yaml
  imports:
    Http: oci://ghcr.io/telorun/http-client@0.19.0#sha256-rDyxrt23Z4u9H1_dwOgI3ajoMwEm6i9h-HbMmEQlRxg
  ```

  A relative path is the way to import a sibling module in this repo — and it
  must carry **no trailing slash and no `/telo.yaml`** (`../auth`, not `../auth/`).
  All three spellings pass `telo check`, but the latter two make `telo release`
  see two publish destinations for one module and fail.

  **Never hand-write or derive a digest — run `telo upgrade <file>`.** It pins an
  unpinned import in place without changing the version (`already at 0.4.3,
  pinned`). `telo module digest` prints a *different* digest in a different
  encoding and is not the one imports use; `IMPORT_UNRESOLVED` also reports the
  correct value when a wrong one is supplied.
  Object form `{ source, variables?, secrets? }` forwards values into the
  imported library. Reference an imported kind as `kind: <Alias>.<KindName>`,
  and an imported instance as `!ref <Alias>.<name>`.
- `variables:` / `secrets:` — NAME-KEYED MAPS. Each entry binds an `env:` var name
  plus a JSON-Schema `type:` (`string|integer|number|boolean|object|array`) and
  optional `default:`. Read in CEL as `variables.X` / `secrets.X`. For a Library,
  these are its **public contract**: importers pass values through the import's
  `variables:` / `secrets:`.
- `ports:` (Application only) — NAME-KEYED MAP; each binds an `env:` var, value is
  implicitly a port integer. Read as `ports.X`.
- `targets:` (Application only) — a flat boot list. Each entry is a `!ref` to a
  Runnable/Service, or an inline invoke step `{ invoke: !ref X, inputs: {…} }`.
- `include:` — array of partial-file globs merged into this module's scope.
- `exports:` (Library only) — `kinds:` (kind names importers may use) and
  `resources:` (instance names importers may `!ref`). The gate is the list: a kind
  or instance not listed is unreachable by importers.

  **Re-export an imported kind or instance by listing it alias-qualified** —
  `<Alias>.<Kind>` — and it becomes available under THIS module's prefix, with no
  local subtype:

  ```yaml
  imports:
    GoogleAuth: ../auth
  exports:
    kinds:
      - GmailClient                    # declared here
      - GoogleAuth.GoogleCredential    # re-exported; consumers write Gmail.GoogleCredential
    resources:
      - GoogleAuth.sharedThing         # same form for instances
  ```

  This is what lets a connector be used standalone — the consumer imports the
  connector and never its dependencies. A **bare** name (`GoogleCredential`)
  names nothing and is rejected with `EXPORT_KIND_UNKNOWN`.

## References and CEL — strict rules

- References use the `!ref` YAML tag ONLY: `!ref name` (local) or
  `!ref Alias.name` (an imported library's exported instance). **NEVER** write a
  reference as a bare string or a `{ kind, name }` object.
- A plain object at a reference slot is an **inline definition**:
  `{ kind: Some.Kind, ...config }` (note: no `name`).
- CEL expressions ALWAYS use the `!cel "..."` YAML tag — never the inline
  `${{ … }}` string form (it round-trips into a broken ref). This applies to pure
  expressions (`!cel "variables.token"`) AND string interpolations
  (`!cel "'Bearer ' + secrets.apiKey"`).
- CEL scopes: `variables`, `secrets` (always); `ports.X` (root app); `resources.X`
  (after that resource snapshots); `steps.<name>.result` (inside a `Run.Sequence`
  step); `request` (inside an HTTP handler); `self` and `inputs` (inside a
  `Telo.Definition` body — see below).
- A resource `metadata.name` must contain NO dot — the `!ref` grammar splits on
  the first dot to separate alias from name.
- Write object / array fields as real YAML maps / lists, never JSON strings; tag
  only the dynamic leaves with `!cel`, never a whole inline collection.

## Where `inputs:` belong — the #1 mistake to avoid

`inputs:` maps caller/request data INTO the resource you are dispatching to, and
it belongs at the **DISPATCH SITE** — right next to the reference that names what
to call (`handler:` on an Http.Api route, `invoke:` on a Run.Sequence step or
`targets` step, `tool:` on an Ai.Tools entry). Put a resource's STATIC config on
the resource itself; put the PER-CALL `inputs:` at the place that CALLS it. CEL is
evaluated in the dispatch site's scope, not the resource's — a standalone resource
has no `request` / `steps` in scope. Every dynamic leaf needs its own `!cel` tag;
a `bindings` list tags each element, never one inline CEL list literal.

## Registering a new kind — `Telo.Definition`

A `Telo.Definition` registers `<module-name>.<Name>`. It carries:

- `capability:` — the lifecycle role (above). Inherited and immutable when
  `extends` is present.
- `schema:` — JSON Schema for the kind's author-facing config, with `x-telo-*`
  annotations.
- One of: a `controllers:` npm locator (TS controller), a **template** body
  (`resources:` + `invoke:`/`provide:`/`run:`/`mount:` + `inputs:`/`result:`), or
  an **inheritance** body (`extends:` + `base:`).
- `inputType:` / `outputType:` — optional typed call contract for Invocables /
  Providers.

Key `x-telo-*` annotations:

- `x-telo-ref: <Alias>.<Kind>` — the field must be a `!ref` to a resource of that
  kind (or a subtype — see inheritance). Write the target as an
  **alias-qualified kind**: `<Alias>.<Kind>` for a module in this file's
  `imports:` map, `Self.<Kind>` for a kind declared in this same library, or
  `Telo.<Kind>` for a built-in capability (`Telo.Invocable`, `Telo.Runnable`,
  `Telo.Mount`, `Telo.Type`, `Telo.Executable`). E.g. an operation's `client`
  field is `Http.Client`.

  Write the **object form** `{ kind: <Alias>.<Kind>, use: <how> }` — the bare
  string is shorthand that leaves `use` unstated. `use:` declares how this
  resource consumes the reference, which is what lets the analyzer reason about
  the topology:

  | `use:` | Meaning | Example slot |
  | --- | --- | --- |
  | `dependency` | A live instance is injected and consumed — not called by you. | an operation's `client`, an S3 `bucketRef`, a server's `mounts[].mount` |
  | `trigger.inbound` | An entry point an inbound event dispatches to. Pair with `x-telo-topology-role: handler`. | an HTTP route `handler`, a Lambda handler |
  | `call` | You invoke it inline as part of your own execution. | a `Codec.Encoder` piped inline, a `Run.Sequence` step's `invoke` |
  | `schema` | It supplies a type, not a runtime value. | `inputType:` / `outputType:` |
  | `detached` | Dispatched in the background; you do not await it. | `Run`'s background `invoke` |

  For a dispatch slot prefer `kind: Telo.Executable` over an
  `anyOf: [Telo.Invocable, Telo.Runnable]` — one kind covers both capabilities,
  so dual-mode kinds like `Run.Sequence` (a Runnable whose controller also
  implements `invoke()`) fit and the kernel calls whichever is appropriate.
  When in doubt, copy the slot from the standard module that does the same job
  (`telo module manifest`) rather than guessing a `use`.
- `x-telo-eval: "compile" | "runtime"` — when `${{}}`/`!cel` in the field is
  evaluated. CEL-bearing fields MUST carry this (or sit under a context region).
  This includes any schema field a CONSUMER will fill with `!cel` — a
  `clientSecret` bound as `!cel "secrets.x"` needs `x-telo-eval: compile`, or
  `telo check` raises `CEL_IN_NON_EVAL_FIELD`.
- `x-telo-context: <schema>` — declares the CEL variables in scope inside a
  handler field (analyzer-only).

Inside a `Telo.Definition` body, CEL sees `self` (typed from this kind's own
`schema:`) and, for Invocable/Runnable kinds, `inputs` (the caller's invoke args,
typed from `inputType:`).

**Mutually exclusive fields belong in one kind with a `oneOf`, not two sibling
kinds.** Two kinds cannot express "exactly one of these"; a `oneOf` makes both
mistakes `telo check` errors with usable messages (`matches no alternative —
expected one with 'accessToken', or one with 'credential'` / `must match exactly
one schema in oneOf`).

```yaml
schema:
  type: object
  required: [baseUrl]
  oneOf:
    - required: [accessToken]
    - required: [credential]
  properties: { ... }
```

## Two ways to build on an existing kind

### A. Inheritance — specialize a kind (`extends` + `base:`)

A `Telo.Definition` may `extends` **any** kind (concrete or abstract), single
inheritance, transitively. A child with no own `controllers:`/template body
**inherits the parent's controller**: the kernel evaluates the child's `base:`
mapping and returns the native parent instance, so the child *is* its parent at
runtime and is accepted at every `!ref` slot the parent is (Liskov-substitutable).

- `base:` — the "`super(...)`" mapping: an object of CEL over `self`, evaluated at
  construction, validated against the parent's schema, fed to the inherited
  controller. It is the sole channel to the parent's config.
- With `base:`, the child's author-facing schema is its **own** schema only (the
  parent's config fields become internal) — a genuine narrowing. Without `base:`,
  the child's schema is `merge(parent, own)` (pure additive extension).
- `base:` constructs the parent config **once**; whether those values are then
  fixed or per-call-overridable is the parent controller's contract (fixed for
  `create()`-consuming kinds like `Http.Client`; overridable defaults for
  `invoke()`-layering kinds like `Http.Request`).
- **An absent optional stays absent through `base:`.** `timeout: !cel "self.timeout"`
  on an unset field forwards nothing, so the PARENT's default applies. Forward
  rather than re-defaulting (`self.?timeout.orValue(60000)`), and a shared default
  lives in exactly one place.
- **`base:` may NOT name a resource declared alongside it.** That shape passes
  `telo check` and fails at runtime with `Resource must have 'kind' property`,
  reported against the *consumer's* manifest. A kind therefore cannot both narrow
  its schema and wire its own internals — take the dependency as a `!ref` field
  instead and let the consumer wire it.
- `extends` chains across module boundaries, transitively: `GmailClient extends
  GoogleAuth.GoogleClient extends Http.Client` works, and the grandchild is
  accepted at every `Http.Client` slot.

This is the canonical way to build a **service client** — specialize the
http-client module's `Client` into a friendly, preconfigured client:

```yaml
kind: Telo.Definition
metadata: { name: GithubClient }
extends: Http.Client                 # inherits the Client controller + Provider capability
schema:
  type: object
  required: [token]
  properties:
    token: { type: string }
base:                                # map friendly config onto the parent's
  baseUrl: https://api.github.com
  headers:
    Authorization: !cel "'Bearer ' + self.token"
    Accept: application/vnd.github+json
```

A consumer instantiates `kind: <Alias>.GithubClient` with `{ token }` and `!ref`s
it into anything that expects an `Http.Client`.

### B. Composition — build an operation over another resource (template)

When behavior varies **per call** (a path/body built from invoke args), use a
template Invocable: declare an internal resource and dispatch to it. `base:`
(construction-time) cannot express a per-call path; composition can.

```yaml
kind: Telo.Definition
metadata: { name: GetRepo }
capability: Telo.Invocable
schema:
  type: object
  required: [client]
  properties:
    client:                            # a GithubClient satisfies this
      x-telo-ref: { kind: Http.Client, use: dependency }
resources:
  - kind: Http.Request
    metadata: { name: !cel "self.name + '-req'" }
    client: !cel "self.client"
    throwOnHttpError: true
invoke: !cel "self.name + '-req'"
inputs:                              # dispatch-site inputs, from the caller's invoke args
  url: !cel "'/repos/' + inputs.owner + '/' + inputs.repo"
  method: GET
```

A template may also **implement an abstract** by dispatching to a concrete
resource — this is how you satisfy a contract like `Http.Credential` with no
controller code:

```yaml
kind: Telo.Definition
metadata: { name: MyCredential }
capability: Telo.Invocable
extends: Http.Credential             # the contract it satisfies
schema: { type: object, required: [token], properties: { token: { type: string, x-telo-eval: compile } } }
resources:
  - kind: Http.BearerToken
    metadata: { name: !cel "self.name + '-inner'" }
    token: !cel "self.token"
invoke:
  kind: Http.BearerToken
  name: !cel "self.name + '-inner'"
inputs:
  request: !cel "inputs.request"
  forceRefresh: !cel "inputs.?forceRefresh.orValue(false)"
```

Use **inheritance** for the client and for fixed/config-driven operations; use
**composition** for operations whose URL/body depend on per-invocation inputs,
and to implement an abstract over an existing concrete kind.
Either way, an operation's `client` slot is typed `Http.Client` (the alias this
file imports http-client under), so a specialized client (a `GithubClient`)
drops straight in.

## Discover modules with telo CLI — DO NOT GUESS FIELDS OR VERSIONS

You have telo CLI at your disposal. Use it
before writing any resource from a module you did not author:

- `telo search "some phrase"` — semantic search for a kind across federated
  modules. (There is no `telo module search`.)
- `telo module manifest <ref>` — fetch a module's `telo.yaml`.
  Its `Telo.Definition` docs ARE JSON Schemas: the EXACT field names, types, and
  required fields. Read `schema` / `inputType` / `outputType` — never invent a
  field from a kind name, and never guess a version. Record the exact OCI
  location ref, `metadata.version`, and integrity digest for the `imports:`
  entry — the full `oci://…@VERSION#sha256-…` string.

Also useful: `https://telo.run/llms.txt` (guide + kind reference),
`https://telo.run/examples.md` (working manifests), `https://telo.run/cel.md`
(CEL function reference).

`telo cel functions` lists what the RUNTIME actually registers and
`telo cel eval "<expr>"` evaluates one — check there rather than trusting the
docs page, which has run ahead of the runtime before.

## CEL in practice — verified traps

- **A `!cel` containing a backslash MUST use a folded block (`!cel >-`).** In a
  double-quoted YAML scalar, `"...\r\n..."` is turned into real CR/LF by the YAML
  parser before CEL ever sees it, and `join(x, '` + newline + `')` is a syntax
  error. In `>-` the backslashes survive.
- **`type(x) == type('')`, not `type(x) == string`.** The bare type identifier
  resolves in `telo cel eval` but is NOT in a manifest's analyzer scope, where it
  fails with `'string' is not defined`.
- **There is no map merge** — `+`, `merge(a,b)` and `a.merge(b)` are all
  unregistered. A child kind can only REPLACE a parent's map field, so document a
  map-valued override as replacing rather than merging.
- **A port is `Telo.TcpPort`, not an int**: `string(ports.http)` has no overload.
  Write `string(dyn(ports.http))` — and derive a test's `baseUrl` from
  `ports.http` that way so the client and the server can never disagree.
- Base64: `base64Encode`/`base64Decode` for text, `bytesToBase64`/`bytesFromBase64`
  for bytes. There is no base64url — translate with
  `replace(replace(x, '+', '-'), '/', '_')` and strip `=`.
- Fixed-width chunking (e.g. RFC 2045 76-char lines):
  `join(range((size(s) + 75) / 76).map(i, slice(s, i * 76, int(min([(i + 1) * 76, size(s)])))), '\r\n')`.
- `Run.Value` `bindings:` are the way to keep a long expression readable — named
  intermediates, evaluated on demand, referenced bare by later bindings.

## Validation & testing

- **`telo check <file.yaml>`** statically validates a manifest (schema checks,
  reference validation, CEL type-checking). Run it after every change; a clean
  file exits 0. Treat each diagnostic — it names a location and a rule — as ground
  truth and fix to zero before finishing.
- **Tests** live in the module they test as `<module>/tests/*.yaml` — Telo
  Application manifests exercised via the kernel (run them with the `telo` CLI /
  the repo's test runner). Fixtures go under `__fixtures__/` (excluded from
  discovery). A test asserts behavior with kinds from the `assert` + `test`
  modules (`oci://ghcr.io/telorun/assert@…`, `oci://ghcr.io/telorun/test@…`).
- **One Application per subject area, not one per module.** A connector's tests
  split by what they cover (`messages.yaml`, `auth.yaml`, `uploads.yaml`), each
  with a header comment saying what that area actually pins.
- **The suite runs files in PARALLEL, so every Application needs its own port**
  — its own `ports:` entry AND its own `env:` name. Two tests defaulting to the
  same port fail intermittently.
- **Share a stub across tests as a `Telo.Library` under `__fixtures__/`** that
  exports a `Server.Api`; each test mounts it on its own `Server.Server`. A
  route `path: /prefix/*` matches at any depth, so one wildcard route per method
  covers a whole REST surface.
- **Assert what went ON THE WIRE, written out literally** — the exact method,
  path, query map and body — so a mistake in a CEL URL builder shows up as a diff
  rather than being re-derived from the manifest under test. Where a value is
  generated (a MIME boundary), normalize it with `regexReplace` and keep the
  comparison exact.
- `Assert.Manifest` pins that an invalid manifest IS rejected: it takes
  `source:` (a path) and `expect: { errors: [ { code, message } ] }`, where
  `message` is a substring. Point it at a deliberately-broken fixture under
  `__fixtures__/`.

**`telo check` passing is necessary, not sufficient — always run the manifest.**
Several shapes check clean and fail at runtime: `base:` naming a sibling
resource, an `Http.Client` with a `credential` declared inside a scope, and an
`exports:` entry that names nothing (which fails in the CONSUMER's file, not
yours). Treat a green check on something structural as unproven until it has
run.

## Versioning — every module change needs a release fragment

A module's published version is `metadata.version` in its `telo.yaml`. **NEVER
hand-edit it.** `telo release` owns it — along with the module's npm controller
version and every `pkg:npm` pin naming it, so a module has ONE version across
`telo.yaml` and `nodejs/package.json`, and one CHANGELOG. There is no second
ledger: changie and changesets are both retired here.

**One release workspace per vendor directory.** `telo release` derives a module's
publish destination as `<registry>/<directory name>` and records one registry base
per workspace, so the anchor sits at `<vendor>/telo-workspace.yaml` (`modules: ["*"]`)
with base `oci://ghcr.io/telorun/<vendor>` — which is what keeps published refs
vendor-nested (`oci://ghcr.io/telorun/aws/s3`). Each vendor owns its
`<vendor>/.changes/ledger.yaml` (a cache of what the registry serves, so the PR gate
needs no credentials) and `<vendor>/.changes/pending/`. `scripts/release.mjs` runs a
subcommand across every vendor.

**Rule: any change to a published module file — `<vendor>/<module>/telo.yaml`, its
`include:` partials, or its controller source — ships with a fragment in the SAME
change.** The fragment is what supplies the changelog line and the level;
`telo release` sees the payload change either way (the digest is exact), so a
missing fragment costs prose and an unattributed patch, not a missed publish.
Test-only, docs-only and plan-only edits need no fragment.

Write one with `telo release add` from inside the vendor directory, or by hand at
`<vendor>/.changes/pending/<slug>.yaml` — one file, several modules, one body:

```yaml
modules:
  youtrack: Added            # the key is the module DIRECTORY name inside the vendor
  sheets: Added
body: "Short description. QUOTE the body — an unquoted ': ' breaks the YAML."
```

Picking `kind:`:

- `Added` / `Deprecated` → **minor**. A new kind or field, a dependency bump, a
  behavior change consumers could notice. Modules are pre-1.0, so breaking changes
  ship as **minor** on purpose, with the break described in the body.
- `Fixed` / `Security` → **patch**. A genuinely behavior-preserving fix.
- `Changed` / `Removed` → major, and `telo release check` **rejects** them. Going
  1.0 must be a deliberate promotion, never a side effect of picking a changelog
  category.

Verify before finishing:

```bash
pnpm run release:check     # CI's gate: fails when no consistent plan can be formed
pnpm run release:status    # the plan itself — what bumps, to what, and why
```

`status` also names what it could not attribute (`payload changed, unattributed`) —
a module whose bytes moved with no fragment, which takes a patch rather than
failing. `pnpm run release:verify` reconciles a ledger against the registry
(`-- --write` to re-record it); a *missing* entry means "never published", not drift.

CI applies the plan: the `module-release` job opens the `chore(release): version
modules` PR with a generated body listing every module that will publish, and
merging it makes `publish-modules` push the artifacts.

## Authoring rules (follow strictly)

- Manifests MUST be type-safe. Wire refs with `!ref`, values with `!cel`, per the
  rules above.
- ALWAYS write CEL with the `!cel "..."` tag — never the inline `${{ }}` form.
- **OCI is the only import form.** Every external dependency is
  `oci://ghcr.io/telorun/<name>@VERSION#sha256-…`, digest-pinned. Sibling modules 
  in this repo are imported by relative path.
- Write `x-telo-ref` as an alias-qualified kind (`Http.Client`, `Self.Bucket`,
  `Telo.Invocable`).
- Prefer composing existing registry modules and specializing existing kinds over
  inventing new kinds or writing controllers. `JS.Script` / TS controllers are a
  last resort — first check whether a generic, reusable kind (composed from the
  standard library, type-safe at the manifest level) fits.
- Never implement logic that swallows errors. Surface failures clearly; set
  `throwOnHttpError: true` on requests whose failures must propagate.
- Keep comments concise; prefer self-documenting manifests and module docs.
- A resource `metadata.name` contains no dot; object/array fields are real YAML,
  not JSON strings; only dynamic leaves are tagged `!cel`.
- Every module change includes documentation. Keep module docs in
  `<module>/docs/` and in sync with the code.
- Every change to a published module file ships a **release fragment**
  (`<vendor>/.changes/pending/*.yaml`) in the same change — see Versioning above.
  Never hand-edit `metadata.version`.
- Design for breadth: when choosing between a generic primitive and a
  use-case-specific shortcut, default to the generic primitive.

## Repo layout

- `<vendor>/<name>/telo.yaml` — the library manifest (e.g.
  `jetbrains/youtrack/telo.yaml`).
- `<vendor>/<name>/tests/*.yaml` — integration tests.
- `<vendor>/<name>/docs/` — module documentation.
- `<vendor>/<name>/plans/` — implementation plans for that module.
- `<vendor>/telo-workspace.yaml` — the vendor's release anchor; `<vendor>/.changes/`
  its ledger and pending fragments (see Versioning).
- `scripts/release.mjs` — a `telo release` subcommand across every vendor;
  `scripts/publish-modules.mjs` — the OCI/npm push pass, gated on version movement
  and per-version presence.

## General rules

- Never use AskUserQuestion tool, ask questions directly;
