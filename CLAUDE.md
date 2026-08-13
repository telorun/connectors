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

  The bare `std/<name>@VERSION` shorthand is **gone** — never write it. A
  relative path (`../`, `../../`) is still the way to import a sibling module in
  this repo from its own tests. Get the exact ref + digest from
  `telo module search` / `telo module manifest`; never hand-write a digest.
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
  `Telo.Mount`, `Telo.Type`). E.g. an operation's `client` field is
  `x-telo-ref: Http.Client`. The legacy `"<namespace>/<module>#<Kind>"` string
  form (`"std/http-client#Client"`) is **deprecated** — the analyzer flags it as
  `X_TELO_REF_LEGACY_IDENTITY`. Never use it. An object form
  `{ kind: <Alias>.<Kind>, use: call|schema|dependency }` spells out how the
  referenced resource is consumed.
- `x-telo-eval: "compile" | "runtime"` — when `${{}}`/`!cel` in the field is
  evaluated. CEL-bearing fields MUST carry this (or sit under a context region).
- `x-telo-context: <schema>` — declares the CEL variables in scope inside a
  handler field (analyzer-only).

Inside a `Telo.Definition` body, CEL sees `self` (typed from this kind's own
`schema:`) and, for Invocable/Runnable kinds, `inputs` (the caller's invoke args,
typed from `inputType:`).

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
    client: { x-telo-ref: Http.Client }   # a GithubClient satisfies this
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

Use **inheritance** for the client and for fixed/config-driven operations; use
**composition** for operations whose URL/body depend on per-invocation inputs.
Either way, an operation's `client` slot is typed `Http.Client` (the alias this
file imports http-client under), so a specialized client (a `GithubClient`)
drops straight in.

## Discover modules with telo CLI — DO NOT GUESS FIELDS OR VERSIONS

You have telo CLI at your disposal. Use it
before writing any resource from a module you did not author:

- `telo module search "some phrase"` — performs semantic search to find appropriate module.
- `telo module manifest <ref>` — fetch a module's `telo.yaml`.
  Its `Telo.Definition` docs ARE JSON Schemas: the EXACT field names, types, and
  required fields. Read `schema` / `inputType` / `outputType` — never invent a
  field from a kind name, and never guess a version. Record the exact OCI
  location ref, `metadata.version`, and integrity digest for the `imports:`
  entry — the full `oci://…@VERSION#sha256-…` string, never a `std/` shorthand.

Also useful: `https://telo.run/llms.txt` (guide + kind reference),
`https://telo.run/examples.md` (working manifests), `https://telo.run/cel.md`
(CEL function reference).

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

## Versioning — every module change needs a changie fragment

A module's published version is `metadata.version` in its `telo.yaml`. **NEVER
hand-edit it.** changie owns telo manifest versions (what ships to the OCI
registry); changesets owns the npm controller packages.

**Rule: any change to a published module file — `<vendor>/<module>/telo.yaml`,
its `include:` partials, or its controller source — ships with a changie
fragment in the SAME change.** A module edit with no fragment is incomplete: the
manifest changes but its version never moves, so consumers pin a digest whose
content silently drifted. Test-only, docs-only, and plan-only edits need no
fragment (they are not published).

Add one per affected module. `changie new --project <module>` is interactive, so
in a non-interactive session write the file directly to
`.changes/unreleased/<module>-<slug>.yaml`:

```yaml
project: youtrack          # the changie project key = the module directory name
kind: Added
body: "Short description. QUOTE the body — an unquoted ': ' breaks the YAML."
```

Picking `kind:` — the level comes from the `auto:` mapping in `.changie.yaml`:

- `Added` → **minor**. Use for a new kind/field, and for a dependency bump or
  behavior change that consumers could notice. Modules are pre-1.0, so breaking
  changes ship as **minor** on purpose.
- `Fixed` → **patch**. Use for a genuinely behavior-preserving fix.
- `Changed` / `Removed` → major, and CI **rejects** them
  (`scripts/check-no-major-module-bump.mjs`) because these modules are pre-1.0.
  Going 1.0 must be a deliberate promotion, never a side effect of picking a
  changelog category.

Verify before finishing — neither check is optional:

```bash
node scripts/check-no-major-module-bump.mjs        # CI guard; regex-only, does NOT catch bad YAML
changie batch auto -j <module> --dry-run           # parses the YAML; prints the resulting version
```

Run the dry-run for **each** module you added a fragment for: it is the only one
of the two that actually parses the fragment, and it shows the version the
fragment resolves to. `.changie.yaml` itself is **generated** — after adding or
removing a module run `node scripts/gen-changie-config.mjs`; CI fails if it
drifts from the module tree.

## Authoring rules (follow strictly)

- Manifests MUST be type-safe. Wire refs with `!ref`, values with `!cel`, per the
  rules above.
- ALWAYS write CEL with the `!cel "..."` tag — never the inline `${{ }}` form.
- **OCI is the only import form.** Every external dependency is
  `oci://ghcr.io/telorun/<name>@VERSION#sha256-…`, digest-pinned. The bare
  `std/<name>@VERSION` shorthand is retired — never introduce one, and convert
  any you find. Sibling modules in this repo are imported by relative path.
- Write `x-telo-ref` as an alias-qualified kind (`Http.Client`, `Self.Bucket`,
  `Telo.Invocable`). The `"<namespace>/<module>#<Kind>"` string form is
  deprecated and flagged by `telo check`.
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
- Every change to a published module file ships a **changie fragment** in the
  same change — see Versioning above. Never hand-edit `metadata.version`.
- Design for breadth: when choosing between a generic primitive and a
  use-case-specific shortcut, default to the generic primitive.

## Repo layout

- `<namespace>/<name>/telo.yaml` — the library manifest (e.g.
  `jetbrains/youtrack/telo.yaml`).
- `<namespace>/<name>/tests/*.yaml` — integration tests.
- `<namespace>/<name>/docs/` — module documentation.
- `<namespace>/<name>/plans/` — implementation plans for that module.
