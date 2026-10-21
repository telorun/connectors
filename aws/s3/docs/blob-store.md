---
description: "S3.Bucket as a Blob.Store: run the storage-neutral Blob.Put, Blob.Get, Blob.Head and Blob.Delete against an S3-compatible bucket"
sidebar_label: Blob store
---

# S3.Bucket as a blob store

> Examples below assume this module is imported under alias `S3` and the blob module under alias `Blob`.

`S3.Bucket` extends `Blob.Store`, the storage contract of the [blob module](https://github.com/telorun/telo/tree/main/modules/blob). A bucket therefore fits every `store:` slot, and the storage-neutral `Blob.Put`, `Blob.Get`, `Blob.Head` and `Blob.Delete` run against it. An application written against `Blob.*` moves between a directory (`BlobFs.Store`) and a bucket by changing one resource.

The blob kinds are imported from the blob module itself — this module does not re-export them, because their names would collide with `S3.Put`, `S3.Get` and `S3.Delete`.

---

## Example

```yaml
kind: Telo.Application
metadata: { name: attachments, version: 1.0.0 }
imports:
  S3: oci://ghcr.io/telorun/aws/s3@<version>
  Blob: oci://ghcr.io/telorun/blob@<version>
secrets:
  accessKeyId: { env: S3_ACCESS_KEY_ID, type: string }
  secretAccessKey: { env: S3_SECRET_ACCESS_KEY, type: string }
---
kind: S3.Bucket
metadata: { name: attachments }
bucketName: my-attachments
endpoint: https://s3.eu-central-1.amazonaws.com
accessKeyId: !cel "secrets.accessKeyId"
secretAccessKey: !cel "secrets.secretAccessKey"
---
kind: Blob.Put
metadata: { name: saveAttachment }
store: !ref attachments
---
kind: Blob.Get
metadata: { name: readAttachment }
store: !ref attachments
```

Invoke `saveAttachment` with `{ key, content, contentType, maxBytes? }` and `readAttachment` with `{ key, maxBytes? }`; see the blob module for the full call contracts and error codes (`ERR_BLOB_NOT_FOUND`, `ERR_BLOB_TOO_LARGE`).

---

## How a bucket meets the contract

| Operation | Requests |
| --- | --- |
| `Blob.Put` | Content that fits in one 8 MiB part is a single `PutObject`. Longer content is a multipart upload sent one part at a time, so memory is bounded by the part size, not by the object. |
| `Blob.Head` | One `HeadObject`. |
| `Blob.Get` | One `HeadObject` for the size and media type; `GetObject` is sent only when the stream is first read. |
| `Blob.Delete` | One `DeleteObject`. |

- **All-or-nothing writes.** When the source fails, the content exceeds `maxBytes`, the call is cancelled or a request fails, a multipart upload is aborted and nothing is stored; the object previously under the key stays readable.
- **Atomic replace.** A reader sees the old object or the new one, never a mixture.
- **A read is pinned to what was described.** The `GetObject` carries `If-Match` with the ETag `HeadObject` reported, so an object replaced or deleted between the two fails the first read instead of delivering other content.
- **Cancellation.** Every request carries the invocation's cancellation signal.
- **Keys are object names, unchanged.** A `Blob.Key` is the object key in the bucket, with no prefix added — `Blob.*` and `S3.*` operations on one bucket see the same objects.

---

## Limits

- **Key grammar.** `Blob.*` accept only a `Blob.Key`: `/`-separated segments of letters, digits, `.`, `_` and `-`, at most 512 characters. Objects whose keys fall outside it (spaces, a leading `/`) are reachable through `S3.Get` / `S3.Delete` only.
- **Object size.** A multipart upload has at most 10,000 parts, so one put stores at most 10,000 × 8 MiB ≈ 78 GiB.
- **A missing bucket reads as a missing object.** `HeadObject` answers 404 for both, so `Blob.Get` and `Blob.Head` report `ERR_BLOB_NOT_FOUND`; `Blob.Put` surfaces the backend's error.
- **Abandoned uploads.** If the process dies mid-upload, the multipart upload is never aborted and its parts stay billed until removed. Configure a lifecycle rule that aborts incomplete multipart uploads.
- Listings and presigned links are not part of the blob contract; use `S3.List` and `S3.PresignedUrl`.
