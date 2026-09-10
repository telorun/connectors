# Google Sheets connector

Typed [Google Sheets API v4](https://developers.google.com/sheets/api) operations
for Telo manifests. A friendly `Http.Client` (`GoogleSheetsClient`,
authenticated by a static OAuth2 access token or a refreshing
`Http.Credential`), plus Invocable operations covering the full read/write
surface. Built on the `google/auth` and `http-client` modules — no controller
code.

## Import

```yaml
imports:
  Sheets: google/sheets@0.1.0
```

Reference kinds as `Sheets.<KindName>` and instances with `!ref`.

## Authentication

Every operation runs against a `GoogleSheetsClient`. It specializes
`GoogleAuth.GoogleClient` from the shared [`google/auth`](../../auth/) module —
which owns the Bearer header, the credential handling, the timeout and Google's
retry curve — and adds the Sheets API host.

- Reads need the `.../auth/spreadsheets.readonly` scope.
- Writes need the `.../auth/spreadsheets` scope.

Authenticate it **one of two ways, and exactly one**. Supplying neither, or
both, is a `telo check` error rather than a 401 at runtime.

**A static token**, for a script or a short-lived run. Any valid OAuth2 access
token works — a service account, `gcloud auth print-access-token`, a user OAuth
flow, or `RefreshAccessToken`:

```yaml
kind: Sheets.GoogleSheetsClient
metadata: { name: Sheets }
accessToken: !cel "secrets.googleAccessToken"
# optional: baseUrl (proxy / stub), timeout (ms, default 60000),
#           retryAttempts (default 3; 0 disables)
```

Google's tokens expire about an hour after issue, so a long-running job had to
re-declare its client on every refresh. **That is what the credential path
fixes** — it is new in this version. Every kind below is a `Sheets.*` kind: the
auth stack is re-exported, so this connector is all you import.

```yaml
kind: Sheets.GoogleAuthServer
metadata: { name: Goog }
---
kind: Sheets.GoogleAuthClient
metadata: { name: App }
authorizationServer: !ref Goog
clientId: !cel "variables.googleClientId"
clientSecret: !cel "secrets.googleClientSecret"
scopes: ["https://www.googleapis.com/auth/spreadsheets"]
---
kind: Sheets.GoogleTokenSource
metadata: { name: Tokens }
client: !ref App
store: !ref Grants            # any KvStore.Store; it must outlive the process
---
kind: Sheets.GoogleCredential
metadata: { name: Cred }
source: !ref Tokens
---
kind: Sheets.GoogleSheetsClient
metadata: { name: Sheets }
credential: !ref Cred
```

The token is then cached, renewed before expiry and renewed again after a 401.
Driving the sign-in itself is `oauth-client`'s job, and every one of its flows
takes the same `source: !ref Tokens` — see
[`google/auth`](../../auth/docs/README.md).

### Retry, and one removed header

The client now retries network failures and 408/429/5xx with exponential
backoff (500 ms initial, 16 s cap), honouring `Retry-After`. `retryAttempts: 0`
turns it off.

`Accept: application/json` is no longer sent. Google's JSON APIs answer with
JSON regardless, and the shared client builds its header map conditionally on
whether a token is present, which leaves no room to merge a second entry.

## Operations

| Kind | Method / endpoint | Purpose |
|------|-------------------|---------|
| `GetSpreadsheet` | `GET /spreadsheets/{id}` | Read metadata (sheet list, properties) and optionally grid data. |
| `CreateSpreadsheet` | `POST /spreadsheets` | Create a new spreadsheet from a Spreadsheet resource. |
| `GetValues` | `GET /spreadsheets/{id}/values/{range}` | Read one A1 range. |
| `BatchGetValues` | `GET /spreadsheets/{id}/values:batchGet` | Read several ranges in one call. |
| `UpdateValues` | `PUT /spreadsheets/{id}/values/{range}` | Overwrite a range with a 2-D array. |
| `AppendValues` | `POST /spreadsheets/{id}/values/{range}:append` | Append rows after the existing table. |
| `ClearValues` | `POST /spreadsheets/{id}/values/{range}:clear` | Clear a range's values (keeps formatting). |
| `BatchUpdateValues` | `POST /spreadsheets/{id}/values:batchUpdate` | Write several ranges in one call. |
| `BatchClearValues` | `POST /spreadsheets/{id}/values:batchClear` | Clear several ranges in one call. |
| `BatchUpdateSpreadsheet` | `POST /spreadsheets/{id}:batchUpdate` | Structural changes — add/delete/rename sheets, format cells, merge, freeze, data validation, … |
| `RefreshAccessToken` | `POST https://oauth2.googleapis.com/token` | Exchange a refresh token for a fresh access token. |

Every operation returns the raw HTTP response as `{ status, headers, body }`;
`body` is the parsed JSON. Requests set `throwOnHttpError: true`, so a 4xx/5xx
propagates as a runtime error rather than a silent bad result.

### Ranges

`range` is A1 notation, e.g. `Sheet1!A1:C10`, `Sheet1` (whole sheet), or
`Sheet1!A:A` (whole column). It is URL-encoded into the request path
automatically — pass it unencoded.

### Values shape

`values` is a 2-D array. `majorDimension` (default `ROWS`) decides whether the
outer array is rows or columns. `valueInputOption` (default `USER_ENTERED`, which
parses formulas/formats as if typed by a user; use `RAW` to store verbatim)
governs how written input is interpreted.

## Examples

Read a range:

```yaml
kind: Sheets.GetValues
metadata: { name: readAll }
client: !ref Sheets
# invoked with: { spreadsheetId, range, valueRenderOption? }
```

```yaml
- name: ReadRows
  invoke: !ref readAll
  inputs:
    spreadsheetId: 1AbC...xyz
    range: "Sheet1!A1:D100"
# steps.ReadRows.result.body.values -> [[...], [...]]
```

Append rows:

```yaml
- name: AppendRow
  invoke: !ref appendRows        # a Sheets.AppendValues instance
  inputs:
    spreadsheetId: 1AbC...xyz
    range: "Sheet1!A1"
    values:
      - ["2026-07-22", "Widget", 42]
```

Add a new tab via `BatchUpdateSpreadsheet`:

```yaml
- name: AddTab
  invoke: !ref batchUpdate        # a Sheets.BatchUpdateSpreadsheet instance
  inputs:
    spreadsheetId: 1AbC...xyz
    requests:
      - addSheet: { properties: { title: "July" } }
```

Refresh the access token, then read (in a `Run.Sequence`):

```yaml
- name: Refresh
  invoke: !ref refresh            # a Sheets.RefreshAccessToken instance
  inputs:
    clientId: !cel "secrets.googleClientId"
    clientSecret: !cel "secrets.googleClientSecret"
    refreshToken: !cel "secrets.googleRefreshToken"
# steps.Refresh.result.body.access_token -> feed a GoogleSheetsClient
```

The `requests` payload for `BatchUpdateSpreadsheet` is the full Sheets API
[Request](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request)
union — formatting, data validation, merges, freezes, conditional formatting, and
more — so the one operation covers the entire structural surface.

## Tests

`tests/operations.yaml` exercises every value/structure operation end-to-end
against a stub HTTP server that echoes the request each operation built, asserting
method, path, query, body, and the baked `Authorization` header. Run it with the
`telo` CLI (`telo run google/sheets/tests/operations.yaml`); it boots the stub
server as a target, so stop it once the assertions have printed.
