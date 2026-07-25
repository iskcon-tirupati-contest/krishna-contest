import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function startMultipart(key: string, contentType: string) {
  const cmd = new CreateMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    ContentType: contentType,
  });
  const out = await s3.send(cmd);
  return { uploadId: out.UploadId! };
}
/*
export async function presignPart(key: string, uploadId: string, partNumber: number) {
  const cmd = new UploadPartCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, cmd, { expiresIn: 60 }); // short-lived
}
*/
export async function presignPart(key: string, uploadId: string, partNumber: number, contentType?: string) {
  const cmd = new UploadPartCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    ...(contentType ? { ContentType: contentType } : {}),
  });
  return getSignedUrl(s3, cmd, { expiresIn: 900 });
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[]
) {
  const cmd = new CompleteMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  });
  await s3.send(cmd);
}

export async function abortMultipart(key: string, uploadId: string) {
  const cmd = new AbortMultipartUploadCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    UploadId: uploadId,
  });
  await s3.send(cmd);
}
