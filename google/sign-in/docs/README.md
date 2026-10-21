# Google sign-in

"Sign in with Google" for a web application. `BrowserSignIn` is a mountable pair
of routes: one sends the browser to Google's consent screen, the other receives
Google's redirect back, exchanges the code and stores the grant in a
`GoogleTokenSource`. A `GoogleCredential` on the same source then authenticates
API calls straight away.

The redirect URI is built from the application's **public address** — a
`Telo.PublicUrl` need — so no domain name is written in a manifest. The same
manifest runs locally, on a runner session and in production; whoever runs it
supplies the address.

For a terminal program use `oauth-client`'s loopback pair
(`RedirectListener`/`RedirectAwait`); for a headless machine its device grant.
This module is for the case where Google redirects to a server you host.

## Routes

| | |
|---|---|
| `GET <path>` | `302` to Google's consent screen. |
| `GET <path>/callback` | Google's redirect back. On success, the grant is stored and the browser sent to `returnTo` (`302`). Otherwise `400` with `{ ok: false, reason }`. |

`path` defaults to `/auth/google`, so the callback is `/auth/google/callback`
and the redirect URI `<public url>/auth/google/callback`. **Register that exact
URI** as an authorized redirect URI of the OAuth client in Google Cloud Console.

`reason` is oauth-client's: `denied` (the user pressed Cancel), `unknown_state`
(no such sign-in in progress, or it was already completed), `expired`,
`issuer_mismatch`, or the provider's own `error` value. It is answered as JSON,
not HTML, because the `error` parameter is whatever is in the URL.

## Wiring

The library declares one need, `site`, of type `Telo.PublicUrl`. An address is
supplied only through the root, so the application declares the need itself —
naming the port it is served on — and forwards it whole at the import:

```yaml
kind: Telo.Application
metadata: { name: MailApp, version: 1.0.0 }
imports:
  Gmail: oci://ghcr.io/telorun/google/gmail@…
  SignIn:
    source: oci://ghcr.io/telorun/google/sign-in@…
    needs:
      site: !ref site
  Server: oci://ghcr.io/telorun/http-server@…
  Redis: oci://ghcr.io/telorun/kv-store-redis@…
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http }
targets: [!ref server]
---
kind: Gmail.GoogleAuthServer
metadata: { name: Google }
---
kind: Gmail.GoogleAuthClient
metadata: { name: App }
authorizationServer: !ref Google
clientId: !cel "variables.googleClientId"
clientSecret: !cel "secrets.googleClientSecret"
scopes: ["https://www.googleapis.com/auth/gmail.readonly"]
---
kind: Gmail.GoogleTokenSource
metadata: { name: Tokens }
client: !ref App
store: !ref Grants              # a KvStore.Store that outlives the process
---
kind: SignIn.BrowserSignIn
metadata: { name: GoogleSignIn }
source: !ref Tokens
returnTo: /inbox
---
kind: Server.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - path: /                     # the routes carry their full path — mount at /
    hostnames: [!ref site]
    mount: !ref GoogleSignIn
```

Mount it at `/`. The routes are declared at their full path (`path`); mounted
under a prefix, Google would redirect to a path the server does not answer. Use
`path` to move them instead.

### Supplying the address

Locally, set the need's variable:

```bash
TELO_NEED_SITE__URL=http://localhost:8080 telo run ./app
```

or bind a name of your own with `env: { url: PUBLIC_URL }` on the
application's need. A host that supplies addresses — a runner session, a
platform with real domains — sets it, or derives it from its
`TELO_HOST_PUBLIC_URL_TEMPLATE`. `telo needs report ./app` lists the variable.

Google accepts `http://localhost` redirect URIs for development; anything else
must be `https`.

## Fields

| Field | |
|-------|--|
| `source` | **Required.** The `GoogleTokenSource` the grant is stored in. |
| `path` | Where sign-in starts; the callback is `<path>/callback`. Defaults to `/auth/google`. |
| `returnTo` | Where the browser goes once the grant is stored. Defaults to `/`. |
| `pendingTtl` | How long the user has to finish consenting. Defaults to oauth-client's `10m`. |

## `redirect_uri_mismatch`

Google refuses a redirect URI its client does not list with
`Error 400: redirect_uri_mismatch`; the page's *request details* show the URI
that was sent. It is always `<site url><path>/callback`, so the fix is to make
the public URL match what the Console registered — `127.0.0.1` is not
`localhost` to Google, and the port and scheme count — or to register the URI
shown. Nothing here keeps a copy of the Console's list: Google offers no API to
read it, and a hand-kept copy would drift from it.

## Why the redirect URI never comes from the request

The URI is fixed from `site` and `path` when the mount is built. Deriving it
from the request's `Host` header would let anyone who can reach the server send
Google's code to a host of their choosing.

## One account per mount

The grant is stored under the source's `key` (`default` unless the
`GoogleTokenSource` sets one), and the key is deliberately **not** taken from
the request: whoever picks the key when a sign-in starts picks whose grant the
callback overwrites. That fits an application acting for one Google account —
a team mailbox, a service's own Drive.

An application signing in many users builds its own two routes over
`oauth-client`'s `Authorization` and `Callback`, taking the key from its own
authenticated session (`key: !cel "'user/' + …"`), as oauth-client's
[browser-served callback](https://github.com/telorun/telo/blob/main/modules/oauth-client/docs/flows.md)
guide shows.

## Why a separate module

An address need must be forwarded by every application importing the library
that declares it — even an optional one. Declared on `google/auth`, it would be
forced on every Gmail, Drive and Sheets consumer, including those that never
sign anyone in through a browser. Here, only an application that imports
`google/sign-in` declares an address.
