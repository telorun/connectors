# Google Sheets connector

Typed [Google Sheets API v4](https://developers.google.com/sheets/api) operations
for Telo manifests. A friendly `Http.Client` (`GoogleSheetsClient`) preconfigured
with an OAuth2 Bearer access token, plus Invocable operations covering the full
read/write surface. Built purely on `std/http-client` — no controller code.

## Import

```yaml
imports:
  Sheets: google/sheets@0.1.0
```

Reference kinds as `Sheets.<KindName>` and instances with `!ref`.

## Authentication

Every operation runs against a `GoogleSheetsClient`, which sends
`Authorization: Bearer <accessToken>` on each request. Any valid OAuth2 access
token works — from a service account, `gcloud auth print-access-token`, a user
OAuth flow, or the `RefreshAccessToken` operation below.

- Reads need the `.../auth/spreadsheets.readonly` scope.
- Writes need the `.../auth/spreadsheets` scope.

Google access tokens expire ~1 hour after issue. `RefreshAccessToken` exchanges
an OAuth2 refresh token for a fresh access token over Google's token endpoint
(pure HTTP, no signing) so a manifest can keep itself authenticated.

```yaml
kind: Sheets.GoogleSheetsClient
metadata: { name: Sheets }
accessToken: !cel "secrets.googleAccessToken"
# optional: baseUrl override for a proxy or a stub server (tests)
```

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
