import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function getClient() {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const endpoint =
    process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function getBucket() {
  return requireEnv("R2_BUCKET_NAME");
}

export function buildDocumentR2Key(
  userId: string,
  sessionId: string,
  documentId: string,
  filename: string,
) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `users/${userId}/sessions/${sessionId}/${documentId}/${safeName}`;
}

export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
) {
  if (body.byteLength === 0) {
    throw new Error("Cannot upload empty file");
  }

  const client = getClient();
  const payload = Buffer.from(body);
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: payload,
      ContentType: contentType,
      ContentLength: payload.byteLength,
    }),
  );
}

export async function getObjectBuffer(key: string) {
  const client = getClient();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );

  const stream = response.Body;
  if (!stream) throw new Error("Empty R2 object body");

  let buffer: Uint8Array;
  if (typeof stream.transformToByteArray === "function") {
    buffer = await stream.transformToByteArray();
  } else {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  if (buffer.byteLength === 0) {
    throw new Error(`Downloaded empty object from R2: ${key}`);
  }

  return buffer;
}

export async function deleteObject(key: string) {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
}

export function buildPageImageR2Key(input: {
  userId: string;
  sessionId: string;
  documentId: string;
  pageIndex: number;
  imageId: string;
  mediaType: string;
}): string {
  const ext = mediaTypeToExtension(input.mediaType);
  return `users/${input.userId}/sessions/${input.sessionId}/${input.documentId}/pages/${input.pageIndex}/images/${input.imageId}.${ext}`;
}

function mediaTypeToExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}
