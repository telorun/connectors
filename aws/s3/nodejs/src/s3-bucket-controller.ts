import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Static, Type } from "@sinclair/typebox";
import type { InvokeContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  deleteBlob,
  getBlob,
  headBlob,
  putBlob,
  type BlobAbsent,
  type BlobContent,
  type BlobFound,
  type BlobPutOptions,
} from "./s3-blob-store.js";
import { isS3NotFound, s3ErrorName } from "./s3-bucket-ref.js";

const schema = Type.Object({
  bucketName: Type.String(),
  endpoint: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
  forcePathStyle: Type.Optional(Type.Boolean()),
  createIfMissing: Type.Optional(Type.Boolean()),
  publicRead: Type.Optional(Type.Boolean()),
});
export type S3BucketManifest = Static<typeof schema>;

/**
 * S3.Bucket — the bucket handle the `S3.*` operations share, and a `Blob.Store`:
 * `put`, `get`, `head` and `delete` are the store contract the `Blob.*`
 * operations call (`s3-blob-store.ts`).
 */
export class S3BucketResource implements ResourceInstance {
  readonly client: S3Client;
  readonly bucketName: string;

  constructor(
    manifest: S3BucketManifest,
    readonly log: Logger,
  ) {
    this.bucketName = manifest.bucketName;
    this.client = new S3Client({
      region: "auto",
      endpoint: manifest.endpoint,
      forcePathStyle: manifest.forcePathStyle ?? false,
      credentials: { accessKeyId: manifest.accessKeyId, secretAccessKey: manifest.secretAccessKey },
    });
  }

  getClient() {
    return this.client;
  }

  put(
    key: string,
    content: AsyncIterable<Uint8Array>,
    options: BlobPutOptions,
    ctx?: InvokeContext,
  ): Promise<void> {
    return putBlob(this, key, content, options, ctx);
  }

  get(key: string, ctx?: InvokeContext): Promise<BlobContent | BlobAbsent> {
    return getBlob(this, key, ctx);
  }

  head(key: string, ctx?: InvokeContext): Promise<BlobFound | BlobAbsent> {
    return headBlob(this, key, ctx);
  }

  delete(key: string, ctx?: InvokeContext): Promise<void> {
    return deleteBlob(this, key, ctx);
  }

  snapshot() {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: S3BucketManifest,
  ctx: ResourceContext,
): Promise<S3BucketResource> {
  ctx.validateSchema(resource, schema);
  const instance = new S3BucketResource(resource, ctx.log);
  if (resource.createIfMissing) {
    await ensureBucket(instance);
  }
  if (resource.publicRead) {
    // await applyPublicReadPolicy(instance);
  }
  return instance;
}

async function ensureBucket(instance: S3BucketResource): Promise<void> {
  if (await bucketExists(instance)) {
    return;
  }
  try {
    await instance.getClient().send(new CreateBucketCommand({ Bucket: instance.bucketName }));
  } catch (err) {
    const name = s3ErrorName(err);
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      return;
    }
    throw err;
  }
}

async function bucketExists(instance: S3BucketResource): Promise<boolean> {
  try {
    await instance.getClient().send(new HeadBucketCommand({ Bucket: instance.bucketName }));
    return true;
  } catch (err) {
    if (isS3NotFound(err)) {
      return false;
    }
    throw err;
  }
}

async function applyPublicReadPolicy(instance: S3BucketResource): Promise<void> {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${instance.bucketName}/*`,
      },
    ],
  };
  await instance.getClient().send(
    new PutBucketPolicyCommand({
      Bucket: instance.bucketName,
      Policy: JSON.stringify(policy),
    }),
  );
}
