# Changelog

## 0.4.1 - 2026-10-28
### Fixed
* Templates name their internal resources with literals and dispatch with '!ref', replacing the deprecated computed names and '{ kind, name }' invoke form. No change to the public kinds.

## 0.4.0 - 2026-10-22
### Added
* Bumped http-client to 0.23.0.

## 0.3.0 - 2026-09-03
### Added
* Upgrade the `http-client` import to 0.22.0, which adds three ready-made `Http.Credential` implementations — `BearerToken`, `ApiKeyHeader` and `QueryKey` — and marks credential headers and query values `x-telo-sensitive`, so auth material is redacted on the debug wire rather than riding every inspected call.

## 0.2.0 - 2026-08-21
### Added
* Declare the operation `client` slots in object form as `kind: Http.Client, use: dependency`, replacing the deprecated `std/http-client#Client` form, and pin the http-client import to the OCI ref `0.19.0`.

## 0.1.0
