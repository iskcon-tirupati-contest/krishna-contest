import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function presignGet(key: string, filename?: string) {
  const safe = (filename || "submission").replace(/[/\\"]/g, "_");
  const cmd = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safe}"`
  });
  return getSignedUrl(s3, cmd, { expiresIn: 60 });
}
