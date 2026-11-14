# Changelog

## 0.4.0 - 2026-11-14
### Added
* Use the built-in Telo.Sequence and Telo.Value in place of the deprecated Run.Sequence and Run.Value, and drop the run import. Behavior is unchanged, but the built-ins need a newer runtime: requires.telo rises to >=0.128.0 for drive and >=0.135.0 for gmail.

## 0.3.2 - 2026-11-14
### Fixed
* Declare the minimum telo runtime (requires.telo >=0.88.0), and pass GoogleClient's retry initialDelay and maxDelay to http-client as CEL durations, which the current Telo.Duration schema requires.

## 0.3.1 - 2026-11-03
### Fixed
* Templates name their internal resources with literals and dispatch with '!ref', replacing the deprecated computed names and '{ kind, name }' invoke form that current Telo rejects at runtime. No change to the public kinds.

## 0.3.0 - 2026-10-22
### Added
* Bumped standard-module dependencies: http-client 0.23.0 (all), oauth-client 0.9.0 and kv-store 0.5.0 (auth), multipart 0.4.0 and run 0.28.0 (drive, gmail).

## 0.2.0 - 2026-09-10
### Added
* New `google/auth` module, and `drive`/`sheets` now build on it. It specializes the `oauth-client` module for Google rather than reimplementing OAuth: `GoogleAuthServer` (issuer `https://accounts.google.com`, so endpoints come from discovery), `GoogleAuthClient` (the registration, sending the `access_type: offline` and `prompt: consent` Google requires before it will issue a refresh token — as named `accessType`/`prompt` fields, alongside `loginHint`, `includeGrantedScopes`, `tokenEndpointAuthMethod` and `pkce`, so that adding a consent parameter cannot displace the two that matter and a public/PKCE client is reachable), `GoogleTokenSource` (durable grant storage, forwarding `grantTtl` and `claimTtl`), `GoogleCredential` (a refreshing `Http.Credential`) and `GoogleClient` (the Bearer header, timeout and Google retry curve, previously restated in each connector). Each connector re-exports the auth kinds under its own prefix, so a consumer imports the connector alone. BREAKING for `drive` and `sheets`: their `RefreshAccessToken` is now an alias of the shared kind — `sheets` gains the `tokenUrl` override it was missing and moves off the retired `Type.JsonSchema` spelling; `sheets` also gains a credential path and retry, and no longer sends `Accept: application/json`. `GoogleDriveOAuthClient` is kept and still works, though `GoogleDriveClient` now accepts a `credential` directly.

## 0.1.0 - 2026-09-05
### Added
* New `google/drive` connector: a `GoogleDriveClient` (static access token or a refreshing `Http.Credential`, retry with backoff) plus typed operations over the whole Drive API v3 surface — files (list, get, download, export, create, multipart and resumable upload, update, copy, delete, trash, ids, watch, labels), permissions, comments, replies, revisions, shared drives, changes, about, channels, apps — and a `RefreshAccessToken` helper.
