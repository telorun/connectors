# Changelog

## 0.2.0 - 2026-08-21
### Added
* Initial k3s module: K3s.Node (abstract), K3s.Server and K3s.Agent converge a machine reachable through any Shell.Host onto a pinned k3s version and a fully typed /etc/rancher/k3s/config.yaml, probing version and config hash first so an unchanged apply installs nothing and restarts nothing.
