import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { InvokeContext, Logger } from "@telorun/sdk";
import { isS3NotFound, s3ErrorName, s3ErrorStatus } from "./s3-bucket-ref.js";

/**
 * The `Blob.Store` contract (blob module, docs/store-contract.md) over one
 * bucket. A store is recognised by its four methods and nothing else, so these
 * shapes are declared here rather than imported from the blob module.
 *
 * A store stores: counting, hashing, byte bounds and every `ERR_BLOB_*` code
 * belong to the `Blob.*` operation kinds. A missing object is the outcome
 * `absent`; any other failure is thrown as it arrives.
 */
export interface BlobPutOptions {
  contentType: string;
}

export interface BlobFound {
  status: "found";
  size: number;
  contentType: string;
}

export interface BlobContent extends BlobFound {
  content: AsyncIterable<Uint8Array>;
}

export interface BlobAbsent {
  status: "absent";
}

/** What a multipart upload sends at a time, and so what a put holds in memory.
 *  S3 refuses a part under 5 MiB unless it is the last. */
const PART_BYTES = 8 * 1024 * 1024;
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

interface Target {
  client: S3Client;
  bucketName: string;
  log: Logger;
}

/**
 * Stores `content` under `key`. A source that ends within the first part is one
 * PutObject; a longer one is a multipart upload, sent a part at a time. Either
 * replaces the object in one step, and an upload that is never completed is
 * invisible to readers — so a failure, the source's or a request's, stores
 * nothing. The source's own failure is rethrown as it was raised.
 */
export async function putBlob(
  target: Target,
  key: string,
  content: AsyncIterable<Uint8Array>,
  options: BlobPutOptions,
  ctx?: InvokeContext,
): Promise<void> {
  const { client, bucketName } = target;
  const abortSignal = ctx?.cancellation.signal;
  const parts = partsOf(content, PART_BYTES)[Symbol.asyncIterator]();

  const first = await parts.next();
  const second = first.done ? first : await parts.next();
  if (second.done) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: first.done ? new Uint8Array(0) : first.value,
        ContentType: options.contentType,
      }),
      { abortSignal },
    );
    return;
  }

  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: options.contentType,
    }),
    { abortSignal },
  );
  if (!UploadId) {
    throw new Error(`S3.Bucket: creating the multipart upload for '${key}' returned no upload id.`);
  }
  try {
    const completed: { ETag: string | undefined; PartNumber: number }[] = [];
    let next: IteratorResult<Uint8Array> = first;
    let queued: IteratorResult<Uint8Array> | undefined = second;
    while (!next.done) {
      const PartNumber = completed.length + 1;
      const { ETag } = await client.send(
        new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          UploadId,
          PartNumber,
          Body: next.value,
        }),
        { abortSignal },
      );
      completed.push({ ETag, PartNumber });
      next = queued ?? (await parts.next());
      queued = undefined;
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: completed },
      }),
      { abortSignal },
    );
  } catch (err) {
    await abortUpload(target, key, UploadId);
    throw err;
  }
}

/** Runs while a failure is already on its way out, and without the call's
 *  cancellation — a cancelled put must still abort — so an upload that cannot
 *  be aborted is reported in the log rather than raised over that failure. */
async function abortUpload(target: Target, key: string, UploadId: string): Promise<void> {
  try {
    await target.client.send(
      new AbortMultipartUploadCommand({ Bucket: target.bucketName, Key: key, UploadId }),
    );
  } catch (err) {
    target.log.warn(
      "Multipart upload left behind",
      { "s3.bucket": target.bucketName, "s3.key": key, "s3.upload_id": UploadId },
      { error: err },
    );
  }
}

/** The source regrouped into parts of exactly `partBytes`, the last one
 *  shorter. Reads the source once, as it comes; its failure passes through. */
async function* partsOf(
  source: AsyncIterable<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = [];
  let held = 0;
  for await (const chunk of source) {
    let rest = chunk;
    while (held + rest.byteLength >= partBytes) {
      const take = partBytes - held;
      pending.push(rest.subarray(0, take));
      yield Buffer.concat(pending, partBytes);
      pending = [];
      held = 0;
      rest = rest.subarray(take);
    }
    if (rest.byteLength > 0) {
      pending.push(rest);
      held += rest.byteLength;
    }
  }
  if (held > 0) yield Buffer.concat(pending, held);
}

export async function headBlob(
  target: Target,
  key: string,
  ctx?: InvokeContext,
): Promise<BlobFound | BlobAbsent> {
  const described = await describe(target, key, ctx);
  if (!described) return { status: "absent" };
  return { status: "found", size: described.size, contentType: described.contentType };
}

/**
 * Describes the object with one metadata request and leaves nothing open: the
 * read request is made at the content's first pull, pinned to the described
 * object by its ETag, and fails that pull unless the object then stored is the
 * one that was described.
 */
export async function getBlob(
  target: Target,
  key: string,
  ctx?: InvokeContext,
): Promise<BlobContent | BlobAbsent> {
  const described = await describe(target, key, ctx);
  if (!described) return { status: "absent" };
  return {
    status: "found",
    size: described.size,
    contentType: described.contentType,
    content: contentOf(() => openDescribed(target, key, described, ctx)),
  };
}

export async function deleteBlob(target: Target, key: string, ctx?: InvokeContext): Promise<void> {
  await target.client.send(new DeleteObjectCommand({ Bucket: target.bucketName, Key: key }), {
    abortSignal: ctx?.cancellation.signal,
  });
}

interface Described {
  size: number;
  contentType: string;
  etag: string | undefined;
}

async function describe(
  target: Target,
  key: string,
  ctx?: InvokeContext,
): Promise<Described | undefined> {
  let response;
  try {
    response = await target.client.send(
      new HeadObjectCommand({ Bucket: target.bucketName, Key: key }),
      { abortSignal: ctx?.cancellation.signal },
    );
  } catch (err) {
    if (isS3NotFound(err)) return undefined;
    throw err;
  }
  return {
    size: response.ContentLength ?? 0,
    contentType: response.ContentType ?? UNKNOWN_MEDIA_TYPE,
    etag: response.ETag,
  };
}

/** A read response body: bytes as they arrive, and a way to drop the rest. */
type Body = AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };

async function openDescribed(
  target: Target,
  key: string,
  described: Described,
  ctx?: InvokeContext,
): Promise<AsyncIterator<Uint8Array>> {
  let response;
  try {
    response = await target.client.send(
      new GetObjectCommand({ Bucket: target.bucketName, Key: key, IfMatch: described.etag }),
      { abortSignal: ctx?.cancellation.signal },
    );
  } catch (err) {
    if (isS3NotFound(err)) {
      throw new Error(
        `S3.Bucket: the blob under '${key}' was deleted before its content was first read.`,
        { cause: err },
      );
    }
    if (s3ErrorName(err) === "PreconditionFailed" || s3ErrorStatus(err) === 412) {
      throw new Error(
        `S3.Bucket: the blob under '${key}' was replaced before its content was first read.`,
        { cause: err },
      );
    }
    throw err;
  }
  const body = response.Body as Body | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw new Error(`S3.Bucket: reading '${key}' returned no iterable body.`);
  }
  const size = response.ContentLength ?? 0;
  const contentType = response.ContentType ?? UNKNOWN_MEDIA_TYPE;
  if (size !== described.size || contentType !== described.contentType) {
    body.destroy?.();
    throw new Error(
      `S3.Bucket: the blob under '${key}' was replaced before its content was first read — ` +
        `it was ${described.size} bytes of ${described.contentType} and is now ${size} bytes of ${contentType}.`,
    );
  }
  return body[Symbol.asyncIterator]();
}

/**
 * A blob's content, read as it is pulled. Nothing is requested until the first
 * pull, so content that is never pulled holds nothing and a release before the
 * first pull has nothing to abort; after it, a release drops the response.
 */
function contentOf(open: () => Promise<AsyncIterator<Uint8Array>>): AsyncIterable<Uint8Array> {
  let reading: AsyncIterator<Uint8Array> | undefined;
  let finished = false;
  const done: IteratorResult<Uint8Array> = { done: true, value: undefined };
  const iterator: AsyncIterator<Uint8Array> = {
    async next() {
      if (finished) return done;
      try {
        reading ??= await open();
        const pulled = await reading.next();
        if (pulled.done) {
          finished = true;
          return done;
        }
        const chunk = pulled.value;
        return { done: false, value: chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk) };
      } catch (err) {
        finished = true;
        throw err;
      }
    },
    async return() {
      finished = true;
      const held = reading;
      reading = undefined;
      await held?.return?.();
      return done;
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}
