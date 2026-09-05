# Google Drive connector

Typed [Google Drive API v3](https://developers.google.com/drive/api/reference/rest/v3)
operations for Telo manifests. Two friendly `Http.Client` kinds
(`GoogleDriveClient` for a static OAuth2 access token, `GoogleDriveOAuthClient`
for a refreshing `Http.Credential`), plus Invocable operations covering the
whole REST surface. Built on the `http-client`, `multipart` and `run` modules —
no controller code.

## Import

```yaml
imports:
  Drive: oci://ghcr.io/telorun/google/drive@0.1.0#sha256-…
```

Reference kinds as `Drive.<KindName>` and instances with `!ref`. Get the exact
ref and digest from `telo upgrade` or the registry.

## Authentication

Every operation runs against one of two client kinds. Both inherit the
`Http.Client` controller, so either satisfies an operation's `client` slot.

- **`GoogleDriveClient`** takes `accessToken`, a bare OAuth2 access token sent
  as `Authorization: Bearer <token>` on every request. Google's tokens expire
  about an hour after issue, and `RefreshAccessToken` exchanges a refresh token
  for a fresh one. Suits a script or a short-lived run.
- **`GoogleDriveOAuthClient`** takes `credential`, any `Http.Credential`:
  `Http.BearerToken` for a fixed token, or a refreshing credential (for example
  from the `oauth-client` module) that re-acquires a token before expiry and
  again when Google answers 401. This is the shape for a long-lived process.

They are separate kinds rather than one client with two optional fields because
a credential is a live resource reference, and a reference cannot be produced
conditionally by an expression — an either/or field would resolve to an empty
object whenever it was left out.

```yaml
kind: Drive.GoogleDriveClient
metadata: { name: Drive }
accessToken: !cel "secrets.googleAccessToken"
# optional: baseUrl (proxy / stub), timeout (ms, default 60000),
#           retryAttempts (default 3; 0 disables)
---
kind: Drive.GoogleDriveOAuthClient
metadata: { name: DriveOAuth }
credential: !ref GoogleOAuth         # any Http.Credential
```

Scopes: `https://www.googleapis.com/auth/drive` (full), `…/drive.file` (files
the app created or opened), `…/drive.readonly`, `…/drive.metadata.readonly`,
`…/drive.appdata`. Shared-drive administration needs `…/drive`; comments and
replies need `…/drive` or `…/drive.file`.

### Retry and rate limits

The client retries network failures and 408/429/5xx responses with exponential
backoff (500 ms initial, 16 s cap) and honours `Retry-After`, which is what
Google's usage-limit guidance asks for. `retryAttempts: 0` turns it off.

Requests whose body is a stream cannot be replayed. `UploadFile` and
`UpdateFileContent` frame a multipart body as a stream, so they disable retry
on their own request: a transient failure surfaces as the real HTTP error.
Retry those at the call site (a `Run.Sequence` step `retry:` re-invokes the whole
operation and re-encodes). A credential refresh on 401 needs a replay too, so a
refreshing credential that renews *before* expiry is the right pairing for
uploads.

## Operations

Every operation takes `client: !ref <a Drive client>` and is invoked with the
inputs listed. All return the raw HTTP response as `{ status, headers, body }`;
`body` is the parsed JSON (bytes or a stream for downloads). Requests set
`throwOnHttpError: true`, so a 4xx/5xx propagates as `ERR_HTTP_STATUS` carrying
the status and Google's error body.

Conventions shared by the operations:

- `supportsAllDrives` defaults to **true** (Google's recommendation; harmless for
  My Drive). Set it to false only for legacy behaviour.
- `fields` is a Drive field mask (`"id,name,mimeType"` or `"*"`). Where the API
  *requires* one (comments, replies, about) it defaults to `"*"`.
- `params` is an escape hatch: a string map appended verbatim to the query, for
  options this module does not name.
- Ids are URL-encoded into paths automatically — pass them unencoded.

### Files

| Kind | Method / endpoint | Purpose |
|------|-------------------|---------|
| `ListFiles` | `GET /drive/v3/files` | List/search with the Drive query grammar (`q`), paging, ordering, shared drives. |
| `GetFile` | `GET /drive/v3/files/{id}` | Read metadata. |
| `DownloadFile` | `GET /drive/v3/files/{id}?alt=media` | Download binary content as bytes (default) or a stream; optional `range`. |
| `ExportFile` | `GET /drive/v3/files/{id}/export` | Export a Docs/Sheets/Slides document to another MIME type (≤10 MB). |
| `CreateFile` | `POST /drive/v3/files` | Create from metadata alone — folders, shortcuts, empty documents. |
| `UpdateFile` | `PATCH /drive/v3/files/{id}` | Change metadata; move with `addParents`/`removeParents`; trash with `{ trashed: true }`. |
| `CopyFile` | `POST /drive/v3/files/{id}/copy` | Copy a file (not folders). |
| `DeleteFile` | `DELETE /drive/v3/files/{id}` | Permanently delete, bypassing the trash. |
| `EmptyTrash` | `DELETE /drive/v3/files/trash` | Empty the user's (or a shared drive's) trash. |
| `GenerateFileIds` | `GET /drive/v3/files/generateIds` | Reserve ids for idempotent creates. |
| `WatchFile` | `POST /drive/v3/files/{id}/watch` | Webhook channel for one file. |
| `ListFileLabels` | `GET /drive/v3/files/{id}/listLabels` | Labels on a file. |
| `ModifyFileLabels` | `POST /drive/v3/files/{id}/modifyLabels` | Apply/change/remove labels atomically. |

### Uploads

| Kind | Method / endpoint | Purpose |
|------|-------------------|---------|
| `UploadFile` | `POST /upload/drive/v3/files?uploadType=multipart` | Create a file with content in one request (≤5 MB). |
| `UpdateFileContent` | `PATCH /upload/drive/v3/files/{id}?uploadType=multipart` | Replace content (new head revision), optionally with metadata. |
| `StartResumableUpload` | `POST`/`PATCH …?uploadType=resumable` | Open a session; the URI is in `headers.location`. |
| `UploadResumableContent` | `PUT <session URI>` | Send all or a chunk (`contentRange`); 308 is returned, not thrown. |
| `UploadFileResumable` | start + `PUT` | One-shot upload of any size; returns the final response plus `uploadUri`. |

`content` is a UTF-8 string, a base64 string (`contentEncoding: base64`), raw
bytes, or a byte stream. `contentType` labels it (default
`application/octet-stream`). `metadata` is the File resource: `name`,
`mimeType`, `parents`, `description`, `properties`, `appProperties`, …

Pick the path by size and durability needs:

- **Multipart** (`UploadFile`) — one round trip, capped at 5 MB by Google.
- **Resumable** (`UploadFileResumable`) — any size, and the session survives a
  failed request: query progress with `UploadResumableContent` and
  `contentRange: "bytes */<total>"`, then send the remainder from the offset in
  the 308's `range` header. Chunks must be multiples of 256 KiB. When `content`
  is a stream pass `contentLength` so the request carries a `Content-Length`
  (Google rejects chunked transfer on this endpoint).

To upload a local file, read it with the `fs` module's `File` kind
(`encoding: base64`) and pass `content` + `contentEncoding: base64`.

### Permissions, comments, replies, revisions

| Kind | Endpoint |
|------|----------|
| `ListPermissions` / `GetPermission` / `CreatePermission` / `UpdatePermission` / `DeletePermission` | `/drive/v3/files/{id}/permissions[/{permissionId}]` |
| `ListComments` / `GetComment` / `CreateComment` / `UpdateComment` / `DeleteComment` | `/drive/v3/files/{id}/comments[/{commentId}]` |
| `ListReplies` / `GetReply` / `CreateReply` / `UpdateReply` / `DeleteReply` | `…/comments/{commentId}/replies[/{replyId}]` |
| `ListRevisions` / `GetRevision` / `DownloadRevision` / `UpdateRevision` / `DeleteRevision` | `/drive/v3/files/{id}/revisions[/{revisionId}]` |

`CreatePermission` takes a Permission resource
(`{ role, type, emailAddress | domain, allowFileDiscovery?, expirationTime? }`)
and the sharing flags (`sendNotificationEmail`, `emailMessage`,
`transferOwnership`, `moveToNewOwnersRoot`, `useDomainAdminAccess`).
`CreateReply` with `{ action: resolve | reopen }` resolves or reopens the comment.

### Shared drives, changes, misc

| Kind | Endpoint | Purpose |
|------|----------|---------|
| `ListDrives` / `GetDrive` / `CreateDrive` / `UpdateDrive` / `DeleteDrive` / `HideDrive` / `UnhideDrive` | `/drive/v3/drives[/{driveId}[/hide|/unhide]]` | Shared drive lifecycle. `CreateDrive` needs an idempotent `requestId`. |
| `GetStartPageToken` | `GET /drive/v3/changes/startPageToken` | Where to start tracking changes. |
| `ListChanges` | `GET /drive/v3/changes` | Changes since a token; store `newStartPageToken` for the next poll. |
| `WatchChanges` | `POST /drive/v3/changes/watch` | Webhook channel for the changes feed. |
| `GetAbout` | `GET /drive/v3/about` | User, storage quota, formats, limits. |
| `StopChannel` | `POST /drive/v3/channels/stop` | Stop a webhook channel (`id` + `resourceId`). |
| `ListApps` / `GetApp` | `/drive/v3/apps[/{appId}]` | Installed Drive apps. |
| `RefreshAccessToken` | `POST https://oauth2.googleapis.com/token` | Refresh token → access token (no client needed; `tokenUrl` override). |

## Examples

Upload a small text file into a folder:

```yaml
kind: Drive.UploadFile
metadata: { name: uploadReport }
client: !ref Drive
# invoked with:
#   metadata: { name: report.csv, parents: [<folderId>] }
#   content: "a,b\n1,2"
#   contentType: text/csv
```

Upload a large binary read from disk, resumably:

```yaml
kind: Run.Sequence
metadata: { name: ship }
steps:
  - name: read
    invoke: !ref readFile            # Fs.File with encoding: base64
    inputs: { path: ./build/app.zip }
  - name: upload
    invoke: !ref uploadResumable     # Drive.UploadFileResumable
    inputs:
      metadata: { name: app.zip, parents: [!cel "variables.folderId"] }
      content: !cel "steps.read.result.content"
      contentEncoding: base64
      contentType: application/zip
      contentLength: !cel "steps.read.result.size"
outputs:
  fileId: !cel "steps.upload.result.body.id"
```

Find, then download, a file by name:

```yaml
steps:
  - name: find
    invoke: !ref listFiles
    inputs:
      q: "name = 'report.csv' and trashed = false"
      fields: files(id,name)
      pageSize: 1
  - name: fetch
    invoke: !ref downloadFile
    inputs:
      fileId: !cel "steps.find.result.body.files[0].id"
      responseType: stream           # pipe steps.fetch.result.body onward
```

Share with a user, then poll for changes:

```yaml
  - name: share
    invoke: !ref createPermission
    inputs:
      fileId: !cel "steps.upload.result.body.id"
      permission: { role: writer, type: user, emailAddress: someone@example.com }
      sendNotificationEmail: false
  - name: token
    invoke: !ref getStartPageToken
  - name: changes
    invoke: !ref listChanges
    inputs:
      pageToken: !cel "steps.token.result.body.startPageToken"
      fields: newStartPageToken,nextPageToken,changes(fileId,removed,file(name))
```

## Errors

- `ERR_HTTP_STATUS` — Google rejected the request; `data.status` and the parsed
  Drive error body (`error.code`, `error.message`, `error.errors[].reason`) are
  attached. Common reasons: `notFound`, `insufficientPermissions`,
  `userRateLimitExceeded` (retried automatically), `storageQuotaExceeded`.
- `ERR_HTTP_BODY_NOT_REPLAYABLE` — a retry or a 401 re-send needed a streamed
  body a second time. See *Retry and rate limits*.
- `ERR_INVALID_CREDENTIAL` — the configured token was empty.

## Testing

`tests/operations.yaml` runs every operation against stub servers (http-server
module) that echo the request and, for uploads, decode the multipart body or
stream the bytes back. Resumable uploads are served on a second port: Google
serves the multipart and resumable POSTs on one path, distinguished only by
`uploadType`, and a router cannot register two handlers for one method and path.
Run it with `telo google/drive/tests/operations.yaml`, or the repo suite with
`pnpm test`.
