# K3s.Server

A control-plane node: API server, scheduler, controller manager, and embedded etcd unless an external datastore is declared.

Extends [`K3s.Node`](agent.md#shared-fields), so it carries every shared node field plus the control-plane surface below.

## clusterInit vs server — the check that earns its keep

```yaml
oneOf:
  - required: [clusterInit]
  - required: [server]
```

Exactly one must be declared. This is the most valuable static check in the module, because getting it wrong **fails silently in k3s**: a joining server with no `server:` URL does not error out — it starts a brand-new one-member cluster alongside the real one, and you find out when workloads land somewhere nobody is looking.

```yaml
# The first server in a cluster. Once only, at the cluster's birth.
kind: K3s.Server
metadata: { name: server-a }
host: !ref node-a
token: !cel "secrets.k3sToken"
clusterInit: true

# Every subsequent server joins.
kind: K3s.Server
metadata: { name: server-b }
host: !ref node-b
token: !cel "secrets.k3sToken"
server: https://10.0.0.11:6443
```

## Control-plane fields

| Field | k3s key | Notes |
| --- | --- | --- |
| `disable` | `disable` | Enum: `coredns`, `servicelb`, `traefik`, `local-storage`, `metrics-server`. A typo is a check error. |
| `disableScheduler` | `disable-scheduler` | |
| `disableCloudController` | `disable-cloud-controller` | |
| `disableKubeProxy` | `disable-kube-proxy` | |
| `disableNetworkPolicy` | `disable-network-policy` | |
| `disableHelmController` | `disable-helm-controller` | |
| `tlsSans` | `tls-san` | Every address a client will ever dial must be listed, or its TLS handshake fails. |
| `clusterCidr` | `cluster-cidr` | Fixed at cluster creation. |
| `serviceCidr` | `service-cidr` | Fixed at cluster creation. |
| `clusterDns` | `cluster-dns` | Must sit inside `serviceCidr`. |
| `clusterDomain` | `cluster-domain` | |
| `flannelBackend` | `flannel-backend` | Enum: `none`, `vxlan`, `host-gw`, `wireguard-native`, `ipsec`. |
| `writeKubeconfigMode` | `write-kubeconfig-mode` | A **string** — `0644` unquoted is 644 decimal. The pattern enforces the quoted octal form. |
| `datastoreEndpoint` | `datastore-endpoint` | External etcd / MySQL / PostgreSQL instead of embedded etcd. |
| `secretsEncryption` | `secrets-encryption` | |
| `etcdSnapshotSchedule` | `etcd-snapshot-schedule-cron` | |
| `etcdSnapshotRetention` | `etcd-snapshot-retention` | |
| `etcdSnapshotDir` | `etcd-snapshot-dir` | |
| `kubeApiServerArgs` | `kube-apiserver-arg` | Passthrough — this is kube-apiserver's surface, not k3s's. |
| `kubeSchedulerArgs` | `kube-scheduler-arg` | Passthrough. |
| `kubeControllerManagerArgs` | `kube-controller-manager-arg` | Passthrough. |

## Fields that are fixed at creation

`clusterCidr`, `serviceCidr` and `clusterDomain` are baked into the cluster when the first server initialises it. Changing them in the manifest later will rewrite `config.yaml` and restart k3s — and k3s will refuse to start, or start inconsistently. Treat them as immutable; changing them means rebuilding the cluster.

The schema cannot express this (there is no prior state to compare against), so it is a documented constraint rather than a check.

## Example

```yaml
kind: K3s.Server
metadata: { name: server-a }
host: !ref node-a
token: !cel "secrets.k3sToken"
version: v1.31.4+k3s1
clusterInit: true
disable: [traefik, servicelb]
tlsSans: [k8s.example.com, 203.0.113.10]
clusterCidr: 10.42.0.0/16
serviceCidr: 10.43.0.0/16
etcdSnapshotSchedule: "0 */6 * * *"
etcdSnapshotRetention: 12
nodeLabels: [role=control-plane]
nodeTaints: [node-role.kubernetes.io/control-plane=true:NoSchedule]
```
