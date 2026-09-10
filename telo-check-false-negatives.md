# `telo check` false negatives: five manifests that pass and then fail

Five manifests that pass `telo check` with a clean exit and then fail — four of
them at runtime, on the very thing the checker was silent about. Found while
building two connectors in `telorun/connectors`, then reduced to minimal
reproductions.

**Environment**

| | |
|---|---|
| telo | 0.88.0 |
| node | v24.11.1 |
| platform | Linux |
| method | each case reduced to its own library + consumer, run with `telo check` then `telo` |

Findings 1–4 were first seen on 0.87.0 and every case was rebuilt from scratch
and re-confirmed on 0.88.0. One further issue observed on 0.87.0 — `provide:`
accepting an undeclared target — **does not reproduce** on 0.88.0 and has been
dropped; it now raises `PROVIDE_TARGET_UNKNOWN` correctly, including on kinds
that also declare `extends`. That fix is the precedent finding 1 asks to extend.

---

## The shape of it

`telo check` is thorough about *tagged* references. A `!ref` to the wrong
capability, an `x-telo-ref` naming an unknown alias, an `extends` with a bad
prefix, a CEL expression touching a field that does not exist, an import whose
digest has moved — all caught precisely, with the offending line and usually the
available alternatives.

The gap is **references written as plain names**: the string in a template's
`invoke:`, the sibling named from an inheritance kind's `base:`, and the entries
in a library's `exports:` list. Those are resolved when the kernel builds the
resource graph, not when the checker reads the file. In three of the five cases
below the runtime already produces an excellent diagnostic — naming the bad
target and listing the valid ones — so the information exists; the checker
simply never asks for it.

One consequence worth stating on its own: in the export case, the manifest that
is wrong passes, and the error surfaces in *somebody else's* file.

## Summary

| # | What passes check | Then | Kind |
|---|---|---|---|
| 1 | `invoke:` naming a resource that is not in `resources:` | Fails at runtime | false negative |
| 2 | `base:` naming a sibling `resources:` entry | Fails at runtime, blames the consumer | false negative |
| 3 | `exports:` naming kinds and resources that do not exist | Fails in the *consumer's* file | false negative |
| 4 | An `Http.Client` with a `credential` inside a template | Fails at runtime | false negative |
| 5 | An un-annotated CEL field — on one kind form but not the other | Hard error on templates only | inconsistency |

---

## Finding 1 — `invoke:` targets are never resolved, though `provide:` targets are

A template kind dispatches to one of its own `resources:` by name. If that name
matches nothing, the checker says nothing. The identical lookup on `provide:`
*is* validated, in the same file, by the same pass — so this is a missing
sibling of an existing rule rather than a missing capability.

```yaml
# lib/telo.yaml — a template Invocable
resources:
  - kind: Run.Value
    metadata: { name: !cel "self.name + '-real'" }
    value: ok
invoke:
  kind: Run.Value
  name: literally-not-declared      # <-- matches nothing
```

```console
$ telo check app.yaml
✓  No issues found
```

```console
$ telo app.yaml
error  L.Op op: Template 'op': 'invoke:' targets 'literally-not-declared' but no
entry in 'resources:' has that metadata.name. Available: 'op-real' (Run.Value).
```

Checking the library on its own gives the same clean result.

It is not a CEL-resolvability limit. The name above is a **static literal** and
still goes unchecked; a CEL-computed name (`!cel "self.name + '-NOPE'"`) behaves
identically. The static case is decidable by string comparison against the
sibling list.

Compare the existing rule, which fires exactly as it should:

```console
# the same mistake on provide: instead of invoke:
telo.yaml:18:9  error  Telo.Definition/Prov: 'provide.name: never-declared-at-all'
does not match any entry's metadata.name in 'resources:'.  PROVIDE_TARGET_UNKNOWN
```

**Suggested fix.** Add `INVOKE_TARGET_UNKNOWN` mirroring
`PROVIDE_TARGET_UNKNOWN`. The runtime message is already the right message —
including the "Available:" list — so it can be lifted wholesale. Worth checking
whether `run:` and `mount:` have the same gap.

---

## Finding 2 — `base:` cannot name a sibling resource, and the failure lands on the wrong file

An inheritance kind (`extends` + `base:`) may declare its own `resources:`.
Pointing `base:` at one of them looks reasonable and passes check — the
equivalent cross-reference *inside a template's* `resources:` genuinely works,
so there is no cue that this position is different.

```yaml
# lib/telo.yaml
extends: Http.Client
resources:
  - kind: Http.BearerToken
    metadata: { name: !cel "self.name + '-cred'" }
    token: !cel "self.token"
base:
  baseUrl: !cel "self.baseUrl"
  credential:                                    # <-- names the sibling above
    kind: Http.BearerToken
    name: !cel "self.name + '-cred'"
```

```console
$ telo check app.yaml
✓  No issues found
```

```console
$ telo app.yaml
error  Http.Request req: [req] Resource must have 'kind' property. Got: {}
```

The diagnosis is the expensive part here. The error names `Http.Request req` — a
resource in the *consumer's* application — and reports an empty object, with
nothing connecting it back to the `base:` mapping in the library that produced
it. Working out that `base:` silently yielded `{}` took a bisect; the message on
its own points nowhere useful.

**Suggested fix.** Decide the semantics and then enforce them. Either resolve
sibling names in `base:` the way templates already do, or reject the shape at
check time with a message that says `base:` may not reference a sibling and
points at the template form instead. Silently producing `{}` is the one outcome
that should not survive.

---

## Finding 3 — `exports:` accepts names that do not exist, and the consumer takes the blame

A library's `exports:` block is its public contract. Nothing validates it. Three
separate spellings of the mistake all pass:

```yaml
# (a) a kind that was simply never declared
exports:
  kinds: [ TotallyMadeUpKind ]
```

```yaml
# (b) an IMPORTED kind — a natural attempt at re-export
imports:
  Http: oci://ghcr.io/telorun/http-client@0.22.0#sha256-…
exports:
  kinds: [ Client ]
```

```yaml
# (c) an instance that does not exist
exports:
  resources: [ noSuchInstance ]
```

```console
$ telo check lib/telo.yaml     # all three
✓  No issues found
```

```console
$ telo check app.yaml
app.yaml:8:7  error  No Telo.Definition found for kind 'L.Client'.  UNDEFINED_KIND
```

The blame is inverted. The author who can fix it sees green; the person who sees
red is holding a file with nothing wrong in it.

Case **(b)** is the one that actually cost time: naming an imported kind in
`exports:` is what you would try first if you wanted a connector to re-export its
dependency's kinds, and a clean check reads as confirmation that it works. It
does not — re-export requires declaring a local kind that `extends` the imported
one.

**Suggested fix.** Validate every `exports.kinds` / `exports.resources` entry
against what the library declares. Give case (b) its own message — the name *is*
resolvable, just not as an export — and say what to write instead. This is the
highest-value fix in the list: cheap, purely local to one file, and it moves an
error from a stranger's terminal to the author's.

---

## Finding 4 — A client carrying a credential inside a template passes, then refuses to initialize

Declaring an `Http.Client` with a `credential` among a template kind's
`resources:` is structurally invalid — the runtime says so clearly, and even
names the remedy. The checker does not mention it.

```yaml
# lib/telo.yaml — inside a template Invocable's resources:
  - kind: Http.BearerToken
    metadata: { name: !cel "self.name + '-cred'" }
    token: tok
  - kind: Http.Client
    metadata: { name: !cel "self.name + '-client'" }
    baseUrl: https://example.invalid
    credential:
      kind: Http.BearerToken
      name: !cel "self.name + '-cred'"
```

```console
$ telo check lib/telo.yaml
✓  No issues found
```

```console
$ telo app.yaml
error  L.Op op: Http.Request: Http.Client "op-client" declares a 'credential' but
is not initialized at this site, so the credential cannot be resolved in the
client's own context. Declare the client at module level rather than inside a scope.
```

Everything needed to raise this is in the manifest: a client, in a scope, with a
credential. No runtime state is involved.

**Suggested fix.** Apply the same rule statically and reuse the runtime's wording
verbatim. Since the constraint is about *where* a client may be declared, it is a
structural check over the resource tree rather than a type check.

---

## Finding 5 — `CEL_IN_NON_EVAL_FIELD` applies to template kinds but not inheritance kinds

Two kinds in one library, each declaring an identical un-annotated field. A
consumer passes `!cel` to both. One is rejected; the other is fine.

```yaml
# both kinds declare, character for character:
schema:
  properties:
    label: { type: string }        # no x-telo-eval on either

# consumer:
kind: L.InheritKind                # extends + base:
label: !cel "variables.who"        # -> accepted

kind: L.TemplateKind               # capability + resources/invoke
label: !cel "variables.who"        # -> CEL_IN_NON_EVAL_FIELD
```

```console
$ telo check app.yaml
app.yaml:16:13  error  L.TemplateKind/b: CEL at 'label' is never evaluated — the
field has no x-telo-eval / x-telo-context annotation, so its value is read as a
literal. Annotate the field as a CEL slot or remove the !cel tag.
CEL_IN_NON_EVAL_FIELD
```

This one is **not** a soundness bug, and it is worth being explicit about that,
because the diagnostic's own wording ("read as a literal") suggests something
alarming. Tested directly with a secret: an `extends: Http.Client` kind whose
un-annotated `secret` field received `!cel "secrets.apiToken"` put
`Bearer s3cr3t-value` on the wire — the resolved value, not the string
`secrets.apiToken`. The inheritance path is safe.

What it costs is predictability. The two declarations are textually identical, so
nothing in the manifest tells an author which rule applies; moving a kind between
the two forms — an ordinary refactor — produces an error on a field nobody
touched.

**Suggested fix.** Pick one rule and apply it to both forms. If the requirement
is genuinely template-only, say so in the message ("inheritance kinds evaluate
schema fields without this annotation"), so the asymmetry is documented at the
point it bites.

---

## What is working well

For balance, and because it narrows where the gap actually is: everything below
was hit during the same work and diagnosed precisely, with the right file, line
and usually the valid alternatives.

| Diagnostic | |
|---|---|
| `IMPORT_UNRESOLVED` | Caught two digests derived by hand, and printed the digest it actually fetched — which is what the fix needs. |
| `REFERENCE_KIND_MISMATCH` | Named the resolved kind, the required kind, and listed the known implementations. |
| `EXTENDS_MALFORMED` | Identified the unresolvable alias rather than just reporting an unknown parent. |
| `X_TELO_REF_UNRESOLVED` | Explained the three valid prefix forms and listed the aliases actually in scope. |
| `CEL_UNKNOWN_FIELD` | Printed every name available in the expression's scope, including sibling bindings. |
| `SCHEMA_VIOLATION` | On a `oneOf`, distinguished "matches no alternative" from "must match exactly one", and named the discriminating properties. |
| `MANIFEST_PARSE_FAILED` | Explained the unquoted `": "` YAML trap and gave the fix inline. |

The common factor in the working set is that each concerns a *tagged*
construct — `!ref`, `x-telo-ref`, `extends`, `!cel`, an import URI. The failing
set is exactly the untagged one: plain strings that name a resource, and plain
strings in an export list.

---

Reproductions are self-contained: one library plus one consumer per case, no
controllers, no network beyond the pinned module imports. Every command and every
line of output quoted above was taken from an actual run rather than
reconstructed.
