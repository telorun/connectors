# K3s.Agent

A worker node: kubelet and the container runtime, no control plane.

Extends `K3s.Node`, so it carries the shared node fields below plus one addition — and, deliberately, **nothing else**. A k3s agent ignores `tls-san`, `disable`, `cluster-cidr`, the whole `etcd-snapshot-*` block and the rest of the control-plane surface. Rather than accept those and silently do nothing with them, `K3s.Agent` does not declare them, so writing one on a worker is a `telo check` error.

That exclusion is the reason server and agent are separate kinds instead of one `K3s.Node` with a `role:` discriminator. A union schema would offer `etcdSnapshotSchedule` in autocomplete on a machine that has no etcd.

## The one agent-only field

```yaml
server:
  type: string
  pattern: '^https://.+:\d+$'
  required
```

Required here, where on a `K3s.Server` it is one of two mutually exclusive modes. An agent with nowhere to join is not a meaningful resource, and making that a schema error is cheaper than discovering it as a node that never registers.

## Shared fields

Declared on `K3s.Node` and available on both kinds.

| Field | k3s key | Notes |
| --- | --- | --- |
| `host` | — | Any `Shell.Host`. Not a k3s setting; it is how the node is reached. |
| `version` | — | `INSTALL_K3S_VERSION`. Pin it — omitted, the node's version becomes an accident of when it was first provisioned. |
| `token` | `token` | The pre-shared cluster secret. Hold it in `secrets:`. |
| `nodeName` | `node-name` | Defaults to the machine's hostname. |
| `nodeIp` | `node-ip` | Set it on any host with more than one interface. |
| `nodeExternalIp` | `node-external-ip` | |
| `nodeLabels` | `node-label` | `key=value`. Applied at registration only — see below. |
| `nodeTaints` | `node-taint` | `key=value:Effect`, effect enforced by pattern. |
| `dataDir` | `data-dir` | Default `/var/lib/rancher/k3s`. |
| `containerRuntimeEndpoint` | `container-runtime-endpoint` | Use an existing CRI runtime instead of bundled containerd. |
| `snapshotter` | `snapshotter` | Enum: `overlayfs`, `native`, `stargz`. |
| `privateRegistry` | `private-registry` | Path to a `registries.yaml` on the host. |
| `resolvConf` | `resolv-conf` | |
| `pauseImage` | `pause-image` | |
| `selinux` | `selinux` | |
| `protectKernelDefaults` | `protect-kernel-defaults` | |
| `kubeletArgs` | `kubelet-arg` | Passthrough — kubelet's surface, not k3s's. |
| `kubeProxyArgs` | `kube-proxy-arg` | Passthrough. |
| `extraConfig` | *(any)* | Escape hatch, merged under the typed fields. |
| `installTimeoutMs` | — | Default 600000. |
| `readyTimeoutMs` | — | Default 300000. |

## Labels and taints are registration-time only

k3s applies `node-label` and `node-taint` when the node **first registers** and does not reconcile them afterwards. Changing `nodeLabels` in the manifest rewrites `config.yaml` and restarts the agent, but the node keeps its original labels — the API server already has a registration for that name.

To relabel, act on the cluster (`kubectl label node ...`) or remove and re-register the node. The schema cannot catch this; it is a k3s behaviour, documented here because the manifest reads as though it should work.

## Readiness

An agent has no local API server to interrogate, so convergence waits on the kubelet's own health endpoint:

```sh
until curl -sf http://127.0.0.1:10248/healthz >/dev/null 2>&1; do sleep 2; done
```

That confirms the kubelet came up. It does **not** confirm the node registered with the control plane — a wrong `token` or an unreachable `server` produces a healthy kubelet that never joins. Checking registration means asking the API server, which is the control plane's concern, not this node's.

## Example

```yaml
kind: K3s.Agent
metadata: { name: agent-b }
host: !ref node-b
token: !cel "secrets.k3sToken"
version: v1.31.4+k3s1
server: https://10.0.0.11:6443
nodeLabels: [role=worker, disk=nvme]
nodeTaints: [workload=batch:NoSchedule]
kubeletArgs: [max-pods=200]
```
