# Telo authoring gaps: one design limitation, one CEL hole, one papercut

The non-checker findings from the same work as
[`telo-check-false-negatives.md`](./telo-check-false-negatives.md) — building
`google/auth` and wiring three connectors onto it in `telorun/connectors`. None
of these is a false negative: in every case `telo check` says the right thing or
the tooling behaves as designed. They are places where the design, the standard
library or a command name made the work harder than it needed to be.

**Environment**

| | |
|---|---|
| telo | 0.88.0 |
| node | v24.11.1 |
| platform | Linux |
| method | each case reduced to a minimal library + consumer and re-run on 0.88.0 |

Three issues have been **dropped after re-testing**, and one of them was my
error rather than a version difference — see *Retracted* at the end. The two
version-related ones: `compact()` was documented on `telo.run/cel.md` but absent from the
runtime registry (it is now registered and works), and an
`ERR_RESOURCE_INITIALIZATION_FAILED` I had attributed to empty subtypes of
template kinds — two independent reductions of that shape now pass, and the
original was almost certainly the unvalidated `provide:` target that 0.88.0
fixed.

## Summary

| # | | Kind |
|---|---|---|
| 1 | A kind cannot narrow its schema and compose internal resources at the same time | design limitation |
| 2 | CEL has no map merge, so a child kind cannot add to a parent's map field | stdlib gap |
| 3 | `telo module digest` prints a digest that is not the one imports use | naming trap |

---

## Finding 1 — narrowing and composing are mutually exclusive

This is the one that changed a design rather than costing an afternoon.

A `Telo.Definition` may take an **inheritance body** (`extends` + `base:`) or a
**template body** (`resources:` + a dispatch). The facade pattern — one resource
that stands for a preconfigured subgraph — needs both halves at once, and no
combination provides them.

The goal: a `GoogleTokenSource` exposing `clientId` and `store`, wiring the
authorization server and the client registration itself, so a consumer writes
one resource rather than three.

**Attempt A — `extends` with a template body.** Without `base:`, the child's
schema is `merge(parent, own)`, so the parent's `required` comes along and the
consumer must supply the very thing the child declares internally:

```yaml
kind: Telo.Definition
metadata: { name: Facade }
extends: OAuth.TokenSource
schema:
  type: object
  required: [clientId, store]        # what the consumer should supply
  properties:
    clientId: { type: string, x-telo-eval: compile }
    store:
      x-telo-ref: { kind: KvStore.Store, use: dependency }
resources:                            # the parent's `client`, built here
  - kind: OAuth.AuthorizationServer
    metadata: { name: !cel "self.name + '-srv'" }
    issuer: https://accounts.google.com
  - kind: OAuth.Client
    metadata: { name: !cel "self.name + '-reg'" }
    authorizationServer:
      kind: OAuth.AuthorizationServer
      name: !cel "self.name + '-srv'"
    clientId: !cel "self.clientId"
```

```console
$ telo check app.yaml
app.yaml:11:1  error  N.Facade/f: / is missing required property 'client'
SCHEMA_VIOLATION
```

The diagnostic is correct and the merge rule is documented. The point is that it
leaves no way to hide the field.

**Attempt B — add `base:` to narrow.** `base:` does narrow the child's schema to
its own, but it may not name a resource declared alongside it. That is
[false-negatives finding 2](./telo-check-false-negatives.md): it passes check
and fails at runtime with `Resource must have 'kind' property`.

So narrowing and composing are each available, and never together.

**Was the limitation right?** Partly, and it is worth saying so. Being forced
onto an explicit four-resource chain caught a real design error: every
`oauth-client` grant operation — `GrantWrite`, `GrantRead`, `Authorization`,
`DeviceToken` — takes a `source:`, and a hidden `TokenSource` cannot be `!ref`ed,
so the facade would have made sign-in unreachable. Explicit resources also stay
visible to the topology analysis the `use:` annotations exist to feed, and keep
lifecycle unambiguous.

The conclusion is not "hiding should be the default". It is that a facade is a
legitimate *optional* convenience over an explicit graph, and there is currently
no way to offer one.

**Suggested fix, in preference order.** Resolving sibling names in `base:` is the
minimal version — the `{kind, name}` form already parses and type-checks, so only
runtime resolution is missing, and it would subsume this finding and
false-negatives finding 2 together. Failing that, documenting the exclusion at
the point it bites (the `SCHEMA_VIOLATION` above could mention that `base:`
narrows but forbids siblings) would at least make the dead end visible in one
step instead of three.

---

## Finding 2 — no map merge in CEL, so a child cannot extend a parent's map

A child kind that inherits a parent with a `map<string,string>` field can only
**replace** it. Three spellings, all rejected:

```console
$ telo cel eval "{'a':1} + {'b':2}"
no such overload: map<string, int> + map<string, int>

$ telo cel eval "merge({'a':1},{'b':2})"
found no matching overload for 'merge(map<string, int>, map<string, int>)'

$ telo cel eval "{'a':1}.merge({'b':2})"
found no matching overload for 'map.merge(map<string, int>)'
```

This hit twice in one module, in both cases forcing a worse API:

**`authorizationParams`.** `GoogleAuthClient` must send `access_type: offline`
and `prompt: consent`, or Google never issues a refresh token. A consumer adding
`login_hint` cannot merge, so the field is documented as replacing the defaults
and the consumer has to restate both — and if they forget, the integration works
for an hour and then stops. A merge would have made the safe thing automatic.

```yaml
authorizationParams: !cel >-
  self.?authorizationParams.orValue({'access_type': 'offline', 'prompt': 'consent'})
```

**`headers`.** `GoogleClient` builds its header map conditionally, since the
`Authorization` entry must be absent rather than empty when a credential is used
instead of a token:

```yaml
headers: !cel "has(self.accessToken) ? {'Authorization': 'Bearer ' + self.accessToken} : {}"
```

There is then nowhere to put a second entry, so `google/sheets` lost the
`Accept: application/json` header it used to send when it moved onto the shared
client. Harmless against Google, but it is a behaviour change forced by a
missing function rather than chosen.

Note this is narrower than the general case: `compact()` gained a map overload in
0.88.0, so map-valued helpers are clearly in scope for the standard library.

**Suggested fix.** A two-argument `merge(map, map)` with right-hand precedence,
matching `compact`'s recent map support. A map comprehension would also solve it
and much else, but merge is the small version that removes both problems above.

---

## Finding 3 — `telo module digest` prints a digest imports cannot use

`imports:` pins a module with `#sha256-<base64url>`. There is a command called
`telo module digest`. It prints a different value, in a different encoding, with
no indication that it is not the one you want:

```console
$ telo module digest oci://ghcr.io/telorun/kv-store@0.4.3
sha256:8dcdc4e4331d4ce163e06fdb449a6aff7a007de938b404cfa7839b0f7a504db6
```

```yaml
# what the import actually needs
Kv: oci://ghcr.io/telorun/kv-store@0.4.3#sha256-4ZipW0W4fvl3I93kI3PEWc7MzkeTH2LOcnRcQynIAjs
```

Not the same bytes, so re-encoding hex to base64url does not recover it:

```console
$ python3 -c "…unhexlify(hex)…urlsafe_b64encode…"
jc3E5DMdTOFj4G_bRJpq_3oAfek4tATPp4ObD3pQTbY     # from `module digest`
4ZipW0W4fvl3I93kI3PEWc7MzkeTH2LOcnRcQynIAjs     # what imports use
```

The command's help calls it "a version's content-identity digest", which reads
exactly like what a content-addressed import would pin. Neither `module digest`
nor any sibling (`versions`, `manifest`, `resources`, `kinds`) prints the import
form.

**This is a papercut, not a gap** — the supported workflow exists and works:

```console
$ telo upgrade telo.yaml
  +  oci://ghcr.io/telorun/kv-store  already at 0.4.3, pinned
0 upgraded, 1 newly pinned
```

`telo upgrade` pins an unpinned import in place, correctly, without changing the
version. That is the right answer and it should be the discoverable one.

**Suggested fix.** One line in `telo module digest --help` saying which digest it
is and pointing at `telo upgrade` for the import pin. Alternatively have it print
both forms. `IMPORT_UNRESOLVED` already reports the correct digest when a wrong
one is supplied, which is how I eventually got it — but that requires guessing
wrong first.

---

## Retracted — re-export already works, and I had the spelling wrong

An earlier draft claimed a library could not re-export an imported kind, and
that making a connector standalone therefore cost one hand-written subtype per
kind. **That is wrong.** Both kinds and instances re-export today, with no
subtype, using the **alias-qualified** spelling:

```yaml
# middle/telo.yaml
imports:
  Inner: ../inner
exports:
  kinds: [ Inner.Greeter ]              # used by a consumer as Middle.Greeter
  resources: [ Inner.sharedGreeter ]    # used as !ref Middle.sharedGreeter
```

Verified through a two-level chain — the consumer imports `Middle` only, never
`Inner` — checking clean and printing `hi telo` / `hi world`.

What I had written was the **bare** name (`Client` rather than `Http.Client`),
which names nothing. That failed silently, and I read the clean check as
confirmation the feature was missing. On 0.88.0 it is caught by
`EXPORT_KIND_UNKNOWN`, whose message names the alias-qualified form — so the
diagnostic that would have saved me is already in place.

Applied to this repo, the correction removed **15 definitions** across the three
Google connectors whose entire content was a name they already had:

```yaml
exports:
  kinds:
    - GmailClient
    - GoogleAuth.GoogleAuthServer
    - GoogleAuth.GoogleAuthClient
    - GoogleAuth.GoogleTokenSource
    - GoogleAuth.GoogleCredential
    - GoogleAuth.RefreshAccessToken
```

A related claim in that draft — that a reference cannot cross an import boundary
— is also wrong. A library declares resource inputs in a top-level `resources:`
block, and an importer supplies them:

```yaml
# library
resources:
  store:
    kind: KvStore.Store
    description: Durable grant storage, supplied by the importer.
```

```yaml
# importer
imports:
  Lib:
    source: ./lib
    resources: { store: !ref myStore }
```

This validates end to end — `RESOURCE_INPUT_UNKNOWN`, `RESOURCE_INPUT_MISSING`
and `RESOURCE_INPUT_KIND_MISMATCH` all fire correctly, and the analyzer
synthesizes a stand-in declaration for the injected resource. I did **not** get
the injected resource to resolve at runtime in my reduction (`'store' must be a
!ref to a resource satisfying KvStore.Store`), but given I got the declaration
spelling wrong twice already, that is far more likely to be a third mistake than
a bug, and it is not reported as one.

The lesson for the checker holds regardless, and it is
[false-negatives finding 3](./telo-check-false-negatives.md): an `exports:` entry
that names nothing should not pass. It cost me a whole design detour.

---

## What is working well

Two things stood out during this work and are worth recording alongside the
gaps.

**`telo upgrade` is the right tool and does the right thing.** It pins,
re-pins and reports precisely what it changed, and distinguishes "already at this
version, newly pinned" from an actual upgrade.

**The `oneOf` diagnostics carry the discriminating information.** Modelling
mutually-exclusive auth as a schema `oneOf` gave both failure modes a usable
message without any custom validation:

```
error  GoogleClient/noAuth:   / matches no alternative — expected one with
                              'accessToken', or one with 'credential'
error  GoogleClient/bothAuth: / must match exactly one schema in oneOf
```

That is what made one client kind with two auth styles a better design than two
sibling kinds — the invalid states two kinds could not express are rejected
before anything runs.

---

Reproductions are self-contained: one library plus one consumer per case, no
controllers, no network beyond the pinned module imports. Every command and
every line of output quoted above was taken from an actual run on 0.88.0.
