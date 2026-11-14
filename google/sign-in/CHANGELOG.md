# Changelog

## 0.1.3 - 2026-11-14
### Fixed
* Use the built-in Telo.Sequence in place of the deprecated Run.Sequence, and drop the run import. Behavior is unchanged.

## 0.1.2 - 2026-11-14
### Fixed
* BrowserSignIn's pendingTtl is now declared as a Telo.Duration, matching the oauth-client field it is forwarded into; the current analyzer rejected the string declaration (TEMPLATE_FORWARD_INCOMPATIBLE). Duration strings such as 10m are still accepted.

## 0.1.0 - 2026-10-22
### Added
* New `google/sign-in` module: `BrowserSignIn`, a mountable sign-in-with-Google route pair for web applications. `GET <path>` (default `/auth/google`) redirects to Google's consent screen and `GET <path>/callback` exchanges the code and stores the grant in a `GoogleTokenSource`, then redirects to `returnTo`. The redirect URI is built from the application's public address — the library declares a `site` need of type `Telo.PublicUrl` that the application forwards at the import — so no domain name is written in a manifest. Requires telo >= 0.118.0.
