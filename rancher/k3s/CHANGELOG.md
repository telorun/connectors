# Changelog

## 0.3.0 - 2026-09-03
### Added
* Upgrade the `run` import to 0.26.0. A controller-only release — every kind schema `K3s` builds on is unchanged; only the module's JS controller layer moved.

## 0.2.0 - 2026-08-21
### Added
* Initial k3s module: K3s.Node (abstract), K3s.Server and K3s.Agent converge a machine reachable through any Shell.Host onto a pinned k3s version and a fully typed /etc/rancher/k3s/config.yaml, probing version and config hash first so an unchanged apply installs nothing and restarts nothing.
