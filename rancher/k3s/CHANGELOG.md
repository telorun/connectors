# Changelog

## 0.4.1 - 2026-10-28
### Fixed
* Templates dispatch with '!ref' to literally named entries and the token is passed with '!cel', replacing deprecated forms. No change to the public kinds.

## 0.4.0 - 2026-10-22
### Added
* Bumped standard-module dependencies: shell 0.13.0, run 0.28.0.

## 0.3.0 - 2026-09-03
### Added
* Upgrade the `run` import to 0.26.0. A controller-only release — every kind schema `K3s` builds on is unchanged; only the module's JS controller layer moved.

## 0.2.0 - 2026-08-21
### Added
* Initial k3s module: K3s.Node (abstract), K3s.Server and K3s.Agent converge a machine reachable through any Shell.Host onto a pinned k3s version and a fully typed /etc/rancher/k3s/config.yaml, probing version and config hash first so an unchanged apply installs nothing and restarts nothing.
