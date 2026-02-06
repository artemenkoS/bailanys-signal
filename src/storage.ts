import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const AVATAR_SIZE = 140;
const AVATAR_MAX_BYTES = 100 * 1024;
const QUALITY_STEPS = [100, 90, 85, 80, 75, 70, 65];

const bucket = process.env.SUPABASE_STORAGE_BUCKET;
const endpoint = process.env.SUPABASE_S3_ENDPOINT;
const region = process.env.SUPABASE_S3_REGION ?? "eu-central-1";
const accessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

function assertStorageConfig() {
  if (!bucket) throw new Error("Missing SUPABASE_STORAGE_BUCKET");
  if (!endpoint) throw new Error("Missing SUPABASE_S3_ENDPOINT");
  if (!accessKeyId) throw new Error("Missing SUPABASE_S3_ACCESS_KEY_ID");
  if (!secretAccessKey)
    throw new Error("Missing SUPABASE_S3_SECRET_ACCESS_KEY");
  if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: {
    accessKeyId: accessKeyId ?? "",
    secretAccessKey: secretAccessKey ?? "",
  },
  forcePathStyle: true,
});

const createAvatarKey = (userId: string) => `${userId}/${Date.now()}.webp`;

const buildPublicUrl = (key: string) => {
  if (!supabaseUrl || !bucket) return "";
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${bucket}/${key}`;
};

export function normalizeAvatarUrl(url?: string | null): string | null {
  if (!url) return null;
  let cleaned = url.trim();
  cleaned = cleaned.replace(/^"+|"+$/g, "");
  if (!bucket) return cleaned;
  const doubleSegment = `/${bucket}/${bucket}/`;
  if (cleaned.includes(doubleSegment)) {
    cleaned = cleaned.replace(doubleSegment, `/${bucket}/`);
  }
  return cleaned;
}

export function extractAvatarKey(url?: string | null): string | null {
  const cleaned = normalizeAvatarUrl(url);
  if (!cleaned || !bucket) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = cleaned.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  const keyWithQuery = cleaned.slice(start);
  return keyWithQuery.split(/[?#]/)[0] || null;
}

export async function processAvatarImage(buffer: Buffer): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const base = sharp(buffer).rotate().resize(AVATAR_SIZE, AVATAR_SIZE, {
    fit: "cover",
    position: "centre",
  });

  let lastBuffer: Buffer | null = null;
  for (const quality of QUALITY_STEPS) {
    const output = await base.clone().webp({ quality }).toBuffer();
    lastBuffer = output;
    if (output.byteLength <= AVATAR_MAX_BYTES) {
      return { buffer: output, contentType: "image/webp" };
    }
  }

  if (lastBuffer && lastBuffer.byteLength <= AVATAR_MAX_BYTES) {
    return { buffer: lastBuffer, contentType: "image/webp" };
  }

  throw new Error("Avatar is too large after compression");
}

export async function uploadAvatar(
  userId: string,
  buffer: Buffer,
  contentType: string,
) {
  assertStorageConfig();
  const key = createAvatarKey(userId);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=300",
    }),
  );
  return { url: buildPublicUrl(key), key };
}

export async function deleteAvatarByKey(key: string) {
  assertStorageConfig();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}

export async function deleteAvatarByUrl(url?: string | null) {
  const key = extractAvatarKey(url);
  if (!key) return;
  await deleteAvatarByKey(key);
}
