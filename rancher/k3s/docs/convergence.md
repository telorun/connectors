# How a node converges

Both `K3s.Server` and `K3s.Agent` run the same five-phase sequence. The shape is what makes re-applying an unchanged manifest free.

```
render → probe → compare → (converge) → ready
```

## 1. render

The typed schema fields are turned into `/etc/rancher/k3s/config.yaml` content, one line per declared field. Absent fields emit nothing.

Each value is serialized with CEL's `json()`. That single call handles strings, booleans, integers and lists correctly at once, because **YAML is a superset of JSON** — `disable: ["traefik","servicelb"]` is a valid YAML flow sequence, and `node-name: "web-01"` is a valid quoted scalar. No per-type quoting logic, no escaping bugs.

Lines are emitted rather than one encoded blob so that the diff a human reads in `git log` is the diff k3s sees.

`extraConfig` keys are appended after the typed lines. k3s takes the last occurrence of a duplicated key, so a typed field always wins over an `extraConfig` entry of the same name.

## 2. probe

One round trip returns both facts the decision needs:

```sh
printf '%s %s' \
  "$(k3s --version 2>/dev/null | head -1 | awk '{print $3}')" \
  "$(sha256sum /etc/rancher/k3s/config.yaml 2>/dev/null | cut -d' ' -f1)"
```

On a machine with no k3s both halves are empty, which compares unequal to anything and reads as "needs everything".

## 3. compare

- `versionMatches` — installed version equals `version`. An **unpinned** `version` matches unconditionally, so omitting the pin never forces a reinstall; it only declines to upgrade.
- `configMatches` — the remote file's sha256 equals `sha256()` of the rendered content, computed locally.

## 4. converge — only on a difference

This branch is the entire reason the module exists rather than a `curl | sh` line in a shell script. Piping the installer unconditionally reinstalls the binary and restarts k3s on *every* apply. On a multi-server cluster that is a rolling control-plane bounce for a run that changed nothing.

Inside the branch:

1. **writeConfig** — the rendered config is base64-encoded before it enters the command line and decoded on the host. No amount of quoting, newlines or shell metacharacters in a rendered value can break out of the command.
2. **install** — `curl -sfL https://get.k3s.io | sh -s - server` (or `agent`), with `INSTALL_K3S_VERSION` in the environment.
3. **installFailed** — `Shell.Command` *returns* a non-zero exit code rather than raising, so the exit code is checked explicitly and re-thrown as `K3S_INSTALL_FAILED` carrying stderr. A failure is never swallowed.
4. **restart** — the installer starts k3s on a fresh machine, but on a machine that already had it the unit is reloaded, not restarted. A rewritten `config.yaml` only takes effect here.

## 5. ready

A server polls its own API server:

```sh
until k3s kubectl get --raw /readyz >/dev/null 2>&1; do sleep 2; done
```

An agent has no local API server, so it polls the kubelet's health endpoint on `127.0.0.1:10248` instead. Both are bounded by `readyTimeoutMs` and raise `K3S_NOT_READY` on expiry.

## Outputs

The sequence returns `{ changed, config }` — whether anything was done, and the config that was rendered. `changed: false` on a second apply is the property the whole design is for.
