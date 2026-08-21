# k3s

Declare k3s cluster nodes in a Telo manifest. Each node is a resource; `telo ./cluster.yaml` converges every machine onto the version and config the manifest declares. Changing the cluster means editing the manifest and re-running it.

## Why use this

- **Every k3s setting is a typed schema field** — `disable: [treafik]` is a `telo check` error, not an add-on that silently stays installed. The valid values are discoverable from the schema instead of from `k3s server --help`.
- **Server and agent are separate kinds** — a k3s agent ignores ~35 control-plane settings. Rather than accept them and do nothing, `K3s.Agent` doesn't declare them, so `etcdSnapshotSchedule` on a worker fails at check time.
- **Re-applying an unchanged manifest does nothing** — both kinds probe the installed version and hash the live `/etc/rancher/k3s/config.yaml` before acting. `curl | sh` in a loop reinstalls the binary and restarts k3s on every run; on a three-server cluster that's a rolling control-plane bounce for a no-op apply.
- **Transport-agnostic** — a node's `host` is any `Shell.Host`. `Shell.LocalHost` for a single machine, an SSH driver for a fleet; the k3s kinds never learn how the target is reached.

## Kinds

| Kind | Purpose |
| --- | --- |
| `K3s.Node` | Abstract. The settings a server and an agent share — identity, addressing, labels, taints, data dir, token, kubelet args. Not instantiable. |
| `K3s.Server` | A control-plane node. Initialises a cluster (`clusterInit`) or joins one (`server`) — exactly one, enforced statically. |
| `K3s.Agent` | A worker node. `server` is required. |

## Example

```yaml
kind: Telo.Application
metadata: { name: cluster, version: 1.0.0 }
imports:
  Shell: oci://ghcr.io/telorun/shell@0.11.2#sha256-sQQV7YpukteJU1z4BijvTav4nhKuML_R_VFDhW5cCfU
  K3s: oci://ghcr.io/telorun/rancher/k3s@0.1.0
secrets:
  k3sToken: { env: K3S_TOKEN, type: string }
targets:
  - !ref server-a
  - !ref agent-b
---
kind: Shell.LocalHost
metadata: { name: node-a }
---
kind: K3s.Server
metadata: { name: server-a }
host: !ref node-a
token: !cel "secrets.k3sToken"
version: v1.31.4+k3s1
clusterInit: true
disable: [traefik, servicelb]
tlsSans: [k8s.example.com]
---
kind: K3s.Agent
metadata: { name: agent-b }
host: !ref node-b
token: !cel "secrets.k3sToken"
version: v1.31.4+k3s1
server: https://10.0.0.11:6443
nodeLabels: [role=worker]
```

Add a worker: one `Shell.Host`, one `K3s.Agent`, one line in `targets`. Upgrade the cluster: change `version` in both places and re-run.

## The token is an input, not an output

Generate the cluster token once, keep it in `secrets:`, hand the same value to every node. Pre-sharing it is what removes the only *data* dependency between nodes — no server has to be bootstrapped and interrogated before an agent can be declared, so nodes are ordered by liveness alone (the `targets:` list), not by discovery.

## What this does not do

- **No reconciliation loop.** `telo ./cluster.yaml` converges once and exits. Hand-edit a node's config afterwards and the drift persists until the next run. Wrap the targets in a scheduler if you want it continuous.
- **No removal.** Deleting a `K3s.Agent` from the manifest leaves that node in the cluster — there is no prior state to diff against. Drain and remove deliberately.
- **No workloads.** This module provisions nodes. Applying Kubernetes objects belongs behind the API server, against a kubeconfig — a separate concern, and a separate module.
- **`nodeLabels` / `nodeTaints` apply at registration only.** k3s does not reconcile them afterwards; changing them alone will not relabel a running node.

## Docs

- [server.md](docs/server.md)
- [agent.md](docs/agent.md)
- [convergence.md](docs/convergence.md)
