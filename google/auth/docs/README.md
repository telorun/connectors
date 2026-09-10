# Google auth

OAuth2 for Google's REST APIs. This module implements no OAuth of its own — it
specializes [`oauth-client`](https://github.com/telorun/telo) for Google and
adds the HTTP-side client every Google connector shares, so the Bearer header,
the retry policy and the parameters Google needs are written once.

Every Google connector re-exports these kinds under its own prefix, so **a
consumer imports the connector alone** and never this module. Import it directly
only for a Google API no connector wraps yet.

## What is here, and what is not

| | |
|---|---|
| `GoogleAuthServer` | Google's issuer, so endpoints come from discovery. |
| `GoogleAuthClient` | The application registration — and the parameters Google needs to issue a refresh token at all. |
| `GoogleTokenSource` | Where grants are stored; what every flow takes as its `source:`. |
| `GoogleCredential` | The refreshing credential to attach to a client. |
| `GoogleClient` | The `Http.Client`: Google's host, header and retry curve. |
| `RefreshAccessToken` | A storage-free one-shot exchange, for scripts. |

**Not here, deliberately:** the sign-in flows. `Authorization`/`Callback` for a
consent redirect, `DeviceAuthorization`/`DeviceToken` for a headless machine,
`ClientCredentials` for service-to-service, and
`TokenRefresh`/`AccessToken`/`GrantRead`/`GrantWrite`/`GrantClear` for managing
what is stored — all live in `oauth-client` and all take the same
`source: !ref <a GoogleTokenSource>`. Wrapping them would add a name and no
value. Import `oauth-client` when you drive a flow; making calls needs nothing
beyond a connector.

Also not here: service-account JWT auth, which needs RS256 signing — CEL offers
`hmac` but no RSA.

## Wiring

Four resources, in order. Each takes the previous, so there is exactly one place
the application is configured and the flow and the calls cannot drift apart.

```yaml
kind: GoogleAuth.GoogleAuthServer
metadata: { name: Goog }
# no configuration — issuer is https://accounts.google.com
---
kind: GoogleAuth.GoogleAuthClient
metadata: { name: App }
authorizationServer: !ref Goog
clientId: !cel "variables.googleClientId"
clientSecret: !cel "secrets.googleClientSecret"
scopes: ["https://www.googleapis.com/auth/drive.readonly"]
---
kind: GoogleAuth.GoogleTokenSource
metadata: { name: Tokens }
client: !ref App
store: !ref Grants            # any KvStore.Store — see below
---
kind: GoogleAuth.GoogleCredential
metadata: { name: Cred }
source: !ref Tokens
---
kind: GoogleAuth.GoogleClient
metadata: { name: Api }
baseUrl: https://www.googleapis.com
credential: !ref Cred
```

### The store must outlive the process

`GoogleTokenSource.store` is any `KvStore.Store` — `kv-store-redis` for a shared
deployment, `kv-store-memory` for tests. A refresh token is a long-lived
credential: an in-memory store means signing in again on every restart.

### `access_type` and `prompt`

`GoogleAuthClient` sends `access_type: offline` and `prompt: consent` on the
consent URL. Google does not return a refresh token without them, which is the
classic reason an integration works for an hour and then stops.

They are **named fields, not entries in a map**, and that is deliberate: CEL has
no map merge, so a free-form `authorizationParams` could only *replace* the
defaults. Adding a `login_hint` would silently drop `access_type: offline`, and
nothing would go red until the refresh token was gone a week later. Named fields
cannot be displaced by anything you add:

```yaml
kind: GoogleAuth.GoogleAuthClient
metadata: { name: App }
authorizationServer: !ref Google
clientId: !cel "variables.clientId"
clientSecret: !cel "secrets.clientSecret"
scopes: ["https://www.googleapis.com/auth/gmail.modify"]
loginHint: someone@example.com    # access_type and prompt survive this
includeGrantedScopes: true
```

| Field | |
|-------|--|
| `accessType` | `offline` (default) or `online`. Offline is what makes a refresh token come back. |
| `prompt` | Defaults to `consent`, which re-issues a refresh token on a repeat authorization. Also `none`, `select_account`, or a space-delimited combination. |
| `loginHint` | Preselect an account. Omitted when unset. |
| `includeGrantedScopes` | Incremental authorization — ask for new scopes, keep the granted ones. Omitted when unset. |

For a provider parameter this module does not name, pass it per-call to
`OAuth.Authorization`'s own `authorizationParams`, which its controller **merges
over** the client's rather than replacing them.

### Public and native clients

A CLI, a native app or a SPA has no client secret and proves itself with PKCE
instead. Both knobs are forwarded to `OAuth.Client`:

```yaml
kind: GoogleAuth.GoogleAuthClient
metadata: { name: Cli }
authorizationServer: !ref Google
clientId: !cel "variables.clientId"
tokenEndpointAuthMethod: none     # without this, HTTP Basic with no secret
scopes: ["https://www.googleapis.com/auth/drive.file"]
```

`tokenEndpointAuthMethod` defaults to `client_secret_basic`, so omitting it on a
secret-less client fails the first token request with *"tokenEndpointAuthMethod
is 'client_secret_basic' but no clientSecret is set"*. `pkce` defaults to `S256`
and takes `plain` or `none` for a server that genuinely cannot do it.

### Grant retention and refresh contention

`GoogleTokenSource` forwards two `OAuth.TokenSource` knobs unchanged:
`grantTtl` (default `8760h`) bounds how long an untouched grant is retained —
every refresh restarts the clock, so it only expires abandoned accounts — and
`claimTtl` (default `30s`) is how long one refresh may hold its key before
another caller takes over. Raise `claimTtl` above the slowest token-endpoint
response you expect, or two callers both refresh.

## `GoogleClient`

An `Http.Client` for a Google API — the HTTP half, which `oauth-client` has no
opinion about.

| Field | |
|-------|--|
| `baseUrl` | **Required.** The API origin, no trailing slash. |
| `accessToken` | A bare OAuth2 access token. Exclusive with `credential`. |
| `credential` | Any `Http.Credential`. Exclusive with `accessToken`. |
| `timeout` | Per-request timeout in ms. Defaults to 60000. |
| `retryAttempts` | Re-attempts for retryable failures. Defaults to 3; 0 disables. |

`baseUrl` is required and has no default because this module knows how to
authenticate a Google request, not which Google API you are calling — Google
publishes each on its own host. A connector supplies its host through `base:`.

Authenticate one of two ways, and **exactly one**. The schema declares them as a
`oneOf`, so supplying neither, or both, is a `telo check` error:

```
error  GoogleClient/noAuth:   / matches no alternative — expected one with
                              'accessToken', or one with 'credential'
error  GoogleClient/bothAuth: / must match exactly one schema in oneOf
```

Two sibling kinds — one per auth style — could not express that: wiring neither
would load fine and then 401.

### Retry policy

Network failures and 408/429/5xx are retried with exponential backoff — 500 ms
initial, 16 s cap — honouring `Retry-After`, which is what Google's usage-limit
guidance asks for. The curve is a property of Google rather than of any one API,
which is the main reason this module exists.

A request whose body is a stream cannot be replayed, so a credential's 401
re-send fails with `ERR_HTTP_BODY_NOT_REPLAYABLE` on a media upload.
`GoogleCredential` renews *before* expiry, which is what keeps that from
happening in practice.

## `RefreshAccessToken`

`POST https://oauth2.googleapis.com/token` — a storage-free exchange of a
refresh token for an access token.

**The lesser of two tools.** It does not cache, does not store the result, does
not handle a rotated refresh token, and does not serialize concurrent refreshes.
It is kept for the case it genuinely fits: a script or CI job holding a refresh
token in a secret, wanting one access token, with no durable store to point a
`GoogleTokenSource` at. For anything long-lived use `GoogleCredential`, or
`oauth-client`'s `TokenRefresh` directly — both do all four.

## Specializing it in a connector

A connector adds its host and re-exports the result under its own name. Because
`base:` narrows, the child declares its own author-facing schema — and forwards
optionals rather than re-defaulting them, so the numbers stay in one place:

```yaml
kind: Telo.Definition
metadata: { name: GmailClient }
extends: GoogleAuth.GoogleClient
schema:
  type: object
  oneOf:
    - required: [accessToken]
    - required: [credential]
  properties: { … }
base:
  baseUrl: !cel "self.?baseUrl.orValue('https://gmail.googleapis.com')"
  accessToken: !cel "self.accessToken"
  credential: !cel "self.credential"
  timeout: !cel "self.timeout"          # absent stays absent; the parent defaults
  retryAttempts: !cel "self.retryAttempts"
```

The auth kinds themselves need no local declaration at all — list them
**alias-qualified** in `exports.kinds` and they re-export under the connector's
own prefix:

```yaml
exports:
  kinds:
    - GmailClient                       # the local specialization
    - GoogleAuth.GoogleAuthServer       # re-exported; used as Gmail.GoogleAuthServer
    - GoogleAuth.GoogleAuthClient
    - GoogleAuth.GoogleTokenSource
    - GoogleAuth.GoogleCredential
    - GoogleAuth.RefreshAccessToken
```

`exports.resources` takes the same `<Alias>.<name>` form for instances. A **bare**
name there (`GoogleAuthServer`) names nothing and is rejected with
`EXPORT_KIND_UNKNOWN`.

### One rule that is not obvious

**An inheritance body's `base:` may not name a resource declared alongside it.**
That shape passes `telo check` and fails at runtime with
`Resource must have 'kind' property` — reported against the *consumer's*
manifest, not the library's. It is why a kind cannot both narrow its schema and
wire its own internals.

## Testing

- `tests/client.yaml` — both auth styles through `GoogleClient`, plus
  `Assert.Manifest` against `tests/__fixtures__/invalid-auth.yaml` pinning that
  the `oneOf` rejects neither/both with the expected diagnostics.
- `tests/credential.yaml` — the whole chain against a stub serving a discovery
  document and a token endpoint: a grant is seeded through the same
  `GoogleTokenSource` the credential draws from, with an already-expired access
  token, and the call must carry the refreshed one.

Run them with `telo google/auth/tests/credential.yaml`, or the repo suite with
`pnpm test`.
