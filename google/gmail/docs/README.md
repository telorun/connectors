# Gmail connector

Typed [Gmail API v1](https://developers.google.com/gmail/api/reference/rest)
operations for Telo manifests. A friendly `Http.Client` (`GmailClient`),
Invocable operations covering the whole REST surface, and a small set of
composition helpers that turn friendly fields into the base64url RFC 2822 string
Gmail actually wants. Built on the `google/auth`, `http-client`, `multipart` and
`run` modules — no controller code.

## Import

```yaml
imports:
  Gmail: oci://ghcr.io/telorun/google/gmail@0.1.0#sha256-…
```

Reference kinds as `Gmail.<KindName>` and instances with `!ref`. Get the exact
ref and digest from `telo upgrade` or the registry.

## Authentication

Every operation runs against a `GmailClient`. It specializes
`GoogleAuth.GoogleClient` from the shared [`google/auth`](../../auth/) module —
which owns the Bearer header, the credential handling, the timeout and Google's
retry curve — and adds Gmail's API host. It is an `Http.Client` at runtime, so
it satisfies any operation's `client` slot.

Authenticate it **one of two ways, and exactly one**. Supplying neither, or
both, is a `telo check` error rather than a 401 at runtime — the schema declares
them as a `oneOf`.

**A static token**, for a script or a short-lived run:

```yaml
kind: Gmail.GmailClient
metadata: { name: Mail }
accessToken: !cel "secrets.gmailAccessToken"
# optional: baseUrl (proxy / stub), timeout (ms, default 60000),
#           retryAttempts (default 3; 0 disables)
```

Google's tokens expire about an hour after issue. `Gmail.RefreshAccessToken`
mints a new one from a refresh token, with no storage — fine for CI, wrong for
anything long-lived.

**A refreshing credential**, for a long-running process. Every kind below is a
`Gmail.*` kind: the auth stack is re-exported, so this connector is all you
import.

```yaml
kind: Gmail.GoogleAuthServer
metadata: { name: Goog }
---
kind: Gmail.GoogleAuthClient
metadata: { name: App }
authorizationServer: !ref Goog
clientId: !cel "variables.googleClientId"
clientSecret: !cel "secrets.googleClientSecret"
scopes: ["https://www.googleapis.com/auth/gmail.modify"]
---
kind: Gmail.GoogleTokenSource
metadata: { name: Tokens }
client: !ref App
store: !ref Grants            # any KvStore.Store; it must outlive the process
---
kind: Gmail.GoogleCredential
metadata: { name: Cred }
source: !ref Tokens
---
kind: Gmail.GmailClient
metadata: { name: Mail }
credential: !ref Cred
```

The token is then cached, renewed before expiry and renewed again after a 401,
and a rotated refresh token replaces the stored one.

Driving the sign-in itself — a consent redirect, a device grant, service-to-service
— is `oauth-client`'s job, and every one of its flows takes the same
`source: !ref Tokens`. See [`google/auth`](../../auth/docs/README.md).

### Scopes

| Scope | What it buys |
|-------|--------------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read messages, threads, labels, settings. |
| `…/auth/gmail.send` | `SendMessage` / `SendEmail` only — no reading. |
| `…/auth/gmail.compose` | Drafts plus send. |
| `…/auth/gmail.modify` | Read, send, and change labels — the usual choice for an assistant. |
| `…/auth/gmail.labels` | Label CRUD. |
| `…/auth/gmail.insert` | `InsertMessage` / `ImportMessage`. |
| `…/auth/gmail.metadata` | Headers and labels, never message bodies. |
| `…/auth/gmail.settings.basic` | Filters, forwarding, vacation, POP/IMAP, send-as. |
| `…/auth/gmail.settings.sharing` | Delegates, S/MIME, send-as with a custom SMTP relay. |
| `https://mail.google.com/` | Everything, including permanent delete. |

`DeleteMessage`, `DeleteThread` and `BatchDeleteMessages` need the full
`https://mail.google.com/` scope — `gmail.modify` is not enough. Delegates and
every `Cse*` operation additionally require a service account with domain-wide
delegation, and CSE needs Workspace Enterprise Plus or Education Plus.

### Retry and rate limits

The client retries network failures and 408/429/5xx responses with exponential
backoff (500 ms initial, 16 s cap) and honours `Retry-After`, which is what
Google's usage-limit guidance asks for. `retryAttempts: 0` turns it off.

Gmail meters two things independently: a per-user rate (250 quota units/second)
and a daily per-project budget. A `SendMessage` costs 100 units against a
`ListMessages`'s 5, so a send loop hits the limit far sooner than a read loop.
The 429s that follow are retried automatically.

Requests whose body is a stream cannot be replayed. The six `*Upload`
operations frame a multipart body as a stream, so they disable retry on their
own request: a transient failure surfaces as the real HTTP error. Retry those at
the call site (a `Run.Sequence` step `retry:` re-invokes the whole operation and
re-encodes). A credential refresh on 401 needs a replay too, so a refreshing
credential that renews *before* expiry is the right pairing for uploads.

## Operations

Every operation takes `client: !ref <a Gmail client>` and is invoked with the
inputs listed. All return the raw HTTP response as `{ status, headers, body }`,
`body` being the parsed JSON. Requests set `throwOnHttpError: true`, so a
4xx/5xx propagates as `ERR_HTTP_STATUS` carrying the status and Google's error
body.

Conventions shared by the operations:

- `userId` defaults to `"me"` — the authenticated mailbox. Pass an address only
  when acting on someone else's mailbox through domain-wide delegation.
- `params` is an escape hatch: a string map appended verbatim to the query, for
  options this module does not name.
- Ids and addresses are URL-encoded into paths automatically — pass them
  unencoded (`d@example.com`, not `d%40example.com`).
- Operations that answer `204 No Content` return `body: null`.

### Messages

| Kind | Method / endpoint | Purpose |
|------|-------------------|---------|
| `ListMessages` | `GET …/messages` | Search with the Gmail query grammar (`q`), paging, label filters. Returns id stubs. |
| `GetMessage` | `GET …/messages/{id}` | One message — `full` (default), `raw`, `metadata` or `minimal`. |
| `SendMessage` | `POST …/messages/send` | Send a base64url RFC 2822 message (≤5 MB). |
| `InsertMessage` | `POST …/messages` | Put a message in the mailbox with no delivery scanning. |
| `ImportMessage` | `POST …/messages/import` | Import through Gmail's normal delivery path (spam, filters, threading). |
| `DeleteMessage` | `DELETE …/messages/{id}` | Permanent, bypasses the trash. |
| `BatchDeleteMessages` | `POST …/messages/batchDelete` | Permanently delete ≤1000 ids. |
| `ModifyMessage` | `POST …/messages/{id}/modify` | Add/remove labels — read, star, archive, file. |
| `BatchModifyMessages` | `POST …/messages/batchModify` | One label change across ≤1000 ids. |
| `TrashMessage` / `UntrashMessage` | `POST …/messages/{id}/trash\|untrash` | Recoverable delete and restore. |
| `GetAttachment` | `GET …/messages/{messageId}/attachments/{id}` | One attachment's base64url bytes. |

`ListMessages` returns `{ id, threadId }` only — Gmail has no "search and return
full messages" call, so follow up with `GetMessage` per id. Common label ids:
`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`,
`CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`.

### Threads, labels, drafts, history

| Kind | Endpoint |
|------|----------|
| `ListThreads` / `GetThread` / `DeleteThread` / `ModifyThread` / `TrashThread` / `UntrashThread` | `…/threads[/{id}[/modify\|/trash\|/untrash]]` |
| `ListLabels` / `GetLabel` / `CreateLabel` / `UpdateLabel` / `PatchLabel` / `DeleteLabel` | `…/labels[/{id}]` |
| `ListDrafts` / `GetDraft` / `CreateDraft` / `UpdateDraft` / `SendDraft` / `DeleteDraft` | `…/drafts[/{id}\|/send]` |
| `ListHistory` | `GET …/history` |

`GetLabel` carries the message and thread counts that `ListLabels` omits.
`PatchLabel` merges; `UpdateLabel` replaces and clears what you leave out.
Nest a label with a slash in its name (`Clients/Acme`).

### Mailbox and push notifications

| Kind | Endpoint | Purpose |
|------|----------|---------|
| `GetProfile` | `GET …/profile` | Address, totals, and the `historyId` to start syncing from. |
| `WatchMailbox` | `POST …/watch` | Subscribe the mailbox to a Cloud Pub/Sub topic. |
| `StopMailbox` | `POST …/stop` | Cancel that subscription. |

The incremental-sync loop is: `GetProfile` (or `WatchMailbox`) for a
`historyId`, then `ListHistory` with `startHistoryId` on every push, storing the
response's `historyId` for next time. `startHistoryId` is **required** — Gmail
answers 400 without it, so the kind rejects the call rather than letting it
reach the API. Gmail keeps roughly a week of history — a
404 from `ListHistory` means the token is too old and a full re-sync is needed.
A `watch` lapses after 7 days, so renew it at least daily.

### Settings

| Kind | Endpoint |
|------|----------|
| `GetAutoForwarding` / `UpdateAutoForwarding` | `…/settings/autoForwarding` |
| `GetImap` / `UpdateImap`, `GetPop` / `UpdatePop` | `…/settings/imap`, `…/settings/pop` |
| `GetVacation` / `UpdateVacation` | `…/settings/vacation` |
| `GetLanguage` / `UpdateLanguage` | `…/settings/language` |
| `ListDelegates` / `GetDelegate` / `CreateDelegate` / `DeleteDelegate` | `…/settings/delegates[/{email}]` |
| `ListFilters` / `GetFilter` / `CreateFilter` / `DeleteFilter` | `…/settings/filters[/{id}]` |
| `ListForwardingAddresses` / `GetForwardingAddress` / `CreateForwardingAddress` / `DeleteForwardingAddress` | `…/settings/forwardingAddresses[/{email}]` |
| `ListSendAs` / `GetSendAs` / `CreateSendAs` / `UpdateSendAs` / `PatchSendAs` / `DeleteSendAs` / `VerifySendAs` | `…/settings/sendAs[/{email}[/verify]]` |
| `ListSmimeInfo` / `GetSmimeInfo` / `InsertSmimeInfo` / `SetDefaultSmimeInfo` / `DeleteSmimeInfo` | `…/settings/sendAs/{email}/smimeInfo[/{id}[/setDefault]]` |
| `ListCseIdentities` / `GetCseIdentity` / `CreateCseIdentity` / `PatchCseIdentity` / `DeleteCseIdentity` | `…/settings/cse/identities[/{email}]` |
| `ListCseKeyPairs` / `GetCseKeyPair` / `CreateCseKeyPair` / `EnableCseKeyPair` / `DisableCseKeyPair` / `ObliterateCseKeyPair` | `…/settings/cse/keypairs[/{id}[:enable\|:disable\|:obliterate]]` |

Filters are immutable — to change one, delete it and create a replacement.
`PatchSendAs` is the call for setting a signature; `UpdateSendAs` clears every
field you omit. `UpdateAutoForwarding` only accepts an address that is already a
*verified* forwarding address.

### Media uploads

Gmail caps the JSON path at a 5 MB message. The upload path sends the RFC 2822
message as a `message/rfc822` part instead of base64url inside JSON, which
raises the ceiling to Gmail's 35 MB message limit and avoids inflating the
payload by a third.

| Kind | Endpoint |
|------|----------|
| `SendMessageUpload` | `POST /upload/…/messages/send?uploadType=multipart` |
| `InsertMessageUpload` | `POST /upload/…/messages?uploadType=multipart` |
| `ImportMessageUpload` | `POST /upload/…/messages/import?uploadType=multipart` |
| `CreateDraftUpload` / `UpdateDraftUpload` / `SendDraftUpload` | `POST\|PUT /upload/…/drafts[/{id}\|/send]?uploadType=multipart` |

Each takes `content` — the message itself as a string, raw bytes or a byte
stream, *not* base64url-encoded — plus the metadata object without its `raw`
field. `contentEncoding: base64` decodes a string `content` to bytes first.

Gmail's resumable upload protocol is deliberately not wrapped: a 35 MB ceiling
fits in one multipart request, and resumable's value is in multi-gigabyte
transfers. Drive it directly with `Http.Request` against
`/resumable/upload/gmail/v1/…` if you need it.

## Composing and reading messages

Gmail's send, insert, import and draft calls all take one thing: an RFC 2822
message, base64url-encoded. These kinds are what make that pleasant.

| Kind | Purpose |
|------|---------|
| `SendEmail` | Compose from friendly fields **and send** — the one-call path. |
| `BuildRawMessage` | Just the composition, for a draft, an insert or an import. |
| `DecodeMessageBody` | A `format: full` Message → decoded text, HTML, headers, attachment list. |
| `DecodeBase64Url` | Gmail's base64url → padded standard base64 and UTF-8 text. |
| `EncodeBase64Url` | Text or standard base64 → unpadded base64url for `message.raw`. |
| `RefreshAccessToken` | Refresh token → access token, no storage (re-exported from `google/auth`; no client needed). |

`SendEmail` and `BuildRawMessage` take the same composition fields: `to`, `cc`,
`bcc` (each one address or a list), `from`, `replyTo`, `subject`, `text`,
`html`, `attachments` and `headers`. What they frame:

| You pass | You get |
|----------|---------|
| `text` | `text/plain` |
| `html` | `text/html` |
| both | `multipart/alternative [ plain, html ]` |
| + attachments | `multipart/mixed [ the above, each attachment ]` |
| + only `inline` attachments | `multipart/related [ the above, each inline part ]` |

Bodies and attachments are always base64 with 76-character lines (RFC 2045
§6.8), which sidesteps 8-bit content, the 998-octet line limit and every charset
question. Line breaks in `text` and `html` are canonicalized to CRLF before
encoding, as RFC 2046 §4.1.1 requires of an encoded `text/*` entity — you can
type `\n` and the decoded body is still correct for a strict parser. A non-ASCII
`subject` is wrapped as an RFC 2047 encoded-word; a non-ASCII attachment name
uses the RFC 2231 `filename*` form, which is the legal spelling in a parameter
value. Mixing inline images with ordinary attachments yields one flat
`multipart/mixed` rather than the strictly-correct `mixed[related[…]]` nesting —
every major client resolves `cid:` references across it.

### What the builder will not let through

RFC 5322 gives a header value no way to escape a line break, so a CR or LF
reaching one *ends* the header — which is how an address field turns into an
attacker's `Bcc`, or terminates the header block and takes over the body. Every
value that becomes a header (`from`, `to`, `cc`, `bcc`, `replyTo`, each
`headers` entry, and an attachment's `contentType` and `contentId`) has each run
of CR/LF plus the whitespace after it collapsed to a single space. For a value
that was legitimately folded — a long `References` — that is exactly RFC 5322
unfolding, so it is preserved rather than mangled; for one that was not, the
injected bytes stay inside the value they arrived in. `subject` needs no such
pass: a CR or LF fails its `^[ -~]*$` ASCII test and it takes the base64
encoded-word branch.

An ASCII attachment `filename` goes in a quoted-string, where `"` and `\` are
backslash-escaped (RFC 2822 §3.2.5) — unescaped, `report"v2.pdf` would close the
parameter early and the recipient would see `report`. A non-ASCII name never
reaches that branch, which is why CR and LF in a filename are already safe.

## Examples

Send a plain message:

```yaml
kind: Gmail.SendEmail
metadata: { name: notify }
client: !ref Mail
# invoked with:
#   to: ann@example.com
#   subject: Nightly build finished
#   text: All green.
```

Send HTML with an inline logo and a PDF read from disk:

```yaml
kind: Run.Sequence
metadata: { name: report }
steps:
  - name: logo
    invoke: !ref readFile          # Fs.File with encoding: base64
    inputs: { path: ./assets/logo.png }
  - name: pdf
    invoke: !ref readFile
    inputs: { path: ./out/report.pdf }
  - name: send
    invoke: !ref sendEmail         # Gmail.SendEmail
    inputs:
      to: [ann@example.com, bob@example.com]
      subject: !cel "'Report for ' + today()"
      text: The report is attached.
      html: '<p><img src="cid:logo"> The report is attached.</p>'
      attachments:
        - filename: logo.png
          content: !cel "steps.logo.result.content"
          contentType: image/png
          contentId: logo
          inline: true
        - filename: report.pdf
          content: !cel "steps.pdf.result.content"
          contentType: application/pdf
outputs:
  messageId: !cel "steps.send.result.body.id"
```

Reply into a thread — Gmail needs `threadId`, a matching subject **and** the
`In-Reply-To` / `References` headers, or it starts a new conversation:

```yaml
steps:
  - name: parent
    invoke: !ref getMessage
    inputs: { id: !cel "inputs.messageId" }
  - name: fields
    invoke: !ref decodeMessage     # Gmail.DecodeMessageBody
    inputs: { message: !cel "steps.parent.result.body" }
  - name: reply
    invoke: !ref sendEmail
    inputs:
      to: !cel "steps.fields.result.from"
      subject: !cel "'Re: ' + steps.fields.result.subject"
      text: Thanks — looking now.
      threadId: !cel "steps.parent.result.body.threadId"
      headers:
        In-Reply-To: !cel "steps.fields.result.messageId"
        References: !cel "steps.fields.result.references + ' ' + steps.fields.result.messageId"
```

Read a message and save its attachments:

```yaml
steps:
  - name: search
    invoke: !ref listMessages
    inputs: { q: "has:attachment from:billing@vendor.com newer_than:7d", maxResults: 1 }
  - name: message
    invoke: !ref getMessage
    inputs: { id: !cel "steps.search.result.body.messages[0].id" }
  - name: parts
    invoke: !ref decodeMessage
    inputs: { message: !cel "steps.message.result.body" }
  - name: fetch
    invoke: !ref getAttachment
    inputs:
      messageId: !cel "steps.message.result.body.id"
      id: !cel "steps.parts.result.attachments[0].attachmentId"
  - name: decode
    invoke: !ref decodeB64          # Gmail.DecodeBase64Url
    inputs: { data: !cel "steps.fetch.result.body.data" }
  - name: save
    invoke: !ref writeFile          # Fs.FileWrite
    inputs:
      path: !cel "'./inbox/' + steps.parts.result.attachments[0].filename"
      content: !cel "steps.decode.result.base64"
      encoding: base64
```

Archive and label everything matching a query:

```yaml
steps:
  - name: find
    invoke: !ref listMessages
    inputs: { q: "from:alerts@example.com is:unread", maxResults: 500 }
  - name: file
    invoke: !ref batchModifyMessages
    inputs:
      ids: !cel "steps.find.result.body.?messages.orValue([]).map(m, m.id)"
      addLabelIds: [Label_alerts]
      removeLabelIds: [INBOX, UNREAD]
```

Poll for changes after a Pub/Sub push:

```yaml
steps:
  - name: watch
    invoke: !ref watchMailbox
    inputs: { topicName: projects/my-project/topics/gmail-push, labelIds: [INBOX] }
  # …later, on each notification:
  - name: changes
    invoke: !ref listHistory
    inputs:
      startHistoryId: !cel "variables.lastHistoryId"
      historyTypes: [messageAdded]
```

## Errors

- `ERR_HTTP_STATUS` — Gmail rejected the request; `data.status` and the parsed
  error body (`error.code`, `error.message`, `error.errors[].reason`) are
  attached. Common reasons: `notFound` (a stale message id — ids change when a
  message is moved), `insufficientPermissions` (the token lacks the scope, e.g.
  a delete without `https://mail.google.com/`), `rateLimitExceeded` and
  `userRateLimitExceeded` (retried automatically), `failedPrecondition` (a
  malformed `raw`, or a forwarding address that is not verified).
- `ERR_HTTP_BODY_NOT_REPLAYABLE` — a retry or a 401 re-send needed a streamed
  body a second time. See *Retry and rate limits*.
- `ERR_INVALID_CREDENTIAL` — the configured token was empty.

A `ListHistory` 404 is not a transport failure: it means `startHistoryId` has
aged out and the mailbox must be re-synced from `GetProfile`.

## Testing

One test per subject area, each a `Telo.Application` you can run on its own:

| File | Covers |
|------|--------|
| `tests/auth.yaml` | Both ways to authenticate a `GmailClient`, and the token grant. |
| `tests/standalone-auth.yaml` | The full OAuth chain built from `Gmail.*` kinds alone — no `google/auth` import. |
| `tests/messages.yaml` | Message operations and attachments. |
| `tests/threads.yaml` | Thread operations. |
| `tests/labels.yaml` | Label operations, including the PUT/PATCH pair. |
| `tests/drafts.yaml` | Draft operations. |
| `tests/mailbox.yaml` | Profile, watch/stop, history. |
| `tests/settings.yaml` | Basic settings, filters, forwarding addresses. |
| `tests/identities.yaml` | Send-as, S/MIME, delegates — the deepest paths. |
| `tests/cse.yaml` | Client-side encryption identities and key pairs. |
| `tests/uploads.yaml` | The six media-upload operations, multipart body decoded. |
| `tests/compose.yaml` | `BuildRawMessage` and `SendEmail`, including header-injection and filename quoting. |
| `tests/decode.yaml` | `DecodeMessageBody` and the base64url codecs — no server. |

They share one stub of the Gmail REST surface,
`tests/__fixtures__/gmail-stub.yaml` — a `Telo.Library` exporting a `Server.Api`
that echoes the method, path, query, body and auth header of every request, and
for the `/upload` routes decodes the multipart/related body back into its parts.
Each test mounts it on its own port, derived from `ports.http` so the client and
the server cannot disagree. `__fixtures__` is excluded from suite discovery, so
the stub is never run as a test itself.

Assertions are written out literally — the exact method, path, query map and
body each operation should put on the wire — so a mistake in the manifest's CEL
URL building shows up as a diff rather than being re-derived from it.
`BuildRawMessage` is compared byte for byte with MIME documents written out in
`compose.yaml` (plain, alternative with a non-ASCII subject, related with an
inline image, mixed with an RFC 2231 filename), the random boundaries normalized
away with `regexReplace`.

Run one with `telo google/gmail/tests/messages.yaml`, or the whole repo suite
with `pnpm test`.
