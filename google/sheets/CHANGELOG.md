# Changelog

## 0.5.0 - 2026-10-22
### Added
* Bumped standard-module dependencies: http-client 0.23.0 (all), oauth-client 0.9.0 and kv-store 0.5.0 (auth), multipart 0.4.0 and run 0.28.0 (drive, gmail).

## 0.4.0 - 2026-09-10
### Added
* New `google/auth` module, and `drive`/`sheets` now build on it. It specializes the `oauth-client` module for Google rather than reimplementing OAuth: `GoogleAuthServer` (issuer `https://accounts.google.com`, so endpoints come from discovery), `GoogleAuthClient` (the registration, sending the `access_type: offline` and `prompt: consent` Google requires before it will issue a refresh token — as named `accessType`/`prompt` fields, alongside `loginHint`, `includeGrantedScopes`, `tokenEndpointAuthMethod` and `pkce`, so that adding a consent parameter cannot displace the two that matter and a public/PKCE client is reachable), `GoogleTokenSource` (durable grant storage, forwarding `grantTtl` and `claimTtl`), `GoogleCredential` (a refreshing `Http.Credential`) and `GoogleClient` (the Bearer header, timeout and Google retry curve, previously restated in each connector). Each connector re-exports the auth kinds under its own prefix, so a consumer imports the connector alone. BREAKING for `drive` and `sheets`: their `RefreshAccessToken` is now an alias of the shared kind — `sheets` gains the `tokenUrl` override it was missing and moves off the retired `Type.JsonSchema` spelling; `sheets` also gains a credential path and retry, and no longer sends `Accept: application/json`. `GoogleDriveOAuthClient` is kept and still works, though `GoogleDriveClient` now accepts a `credential` directly.

## 0.3.0 - 2026-09-03
### Added
* Upgrade the `http-client` import to 0.22.0, which adds three ready-made `Http.Credential` implementations — `BearerToken`, `ApiKeyHeader` and `QueryKey` — and marks credential headers and query values `x-telo-sensitive`, so auth material is redacted on the debug wire rather than riding every inspected call.

## 0.2.0 - 2026-08-21
### Added
* Declare the operation `client` slots in object form as `kind: Http.Client, use: dependency`, replacing the deprecated `std/http-client#Client` form, and pin the http-client import to the OCI ref `0.19.0`.

## 0.1.0
