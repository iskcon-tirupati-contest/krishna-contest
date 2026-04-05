import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({ region: process.env.AWS_REGION });

const FALLBACK_BASENAME = "submission";
const DEFAULT_EXT = "bin";
const MAX_BASE_LEN = 80;

/**
 * Keep only a safe lowercase extension.
 * Examples:
 *   "my essay.DOCX" -> "docx"
 *   "abc..pdf" -> "pdf"
 *   "filename" -> ""
 */
function getSafeExtension(filename?: string): string {
  const raw = String(filename || "").trim();
  const idx = raw.lastIndexOf(".");
  if (idx <= 0 || idx === raw.length - 1) return "";
  return raw.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Remove extension from the name.
 */
function stripLastExtension(filename?: string): string {
  const raw = String(filename || "").trim();
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return raw;
  return raw.slice(0, idx);
}

/**
 * Convert any user filename to ASCII-only header-safe basename.
 * This avoids S3 InvalidArgument / ISO-8859-1 problems.
 */
function toHeaderSafeBaseName(filename?: string): string {
  let base = stripLastExtension(filename);

  // Normalize Unicode when available
  try {
    base = base.normalize("NFKD");
  } catch {
    // ignore if normalize is unavailable
  }

  base = base
    .replace(/[\u0300-\u036f]/g, "")   // remove combining marks
    .replace(/[^\x20-\x7E]/g, "_")     // non-ASCII -> _
    .replace(/[%\/\\"]/g, "_")         // risky header/path chars
    .replace(/[;=,]/g, "_")            // risky header separators
    .replace(/[\r\n\t]/g, " ")         // control whitespace
    .replace(/\s+/g, " ")              // collapse spaces
    .replace(/\.+/g, ".")              // repeated dots
    .trim();

  // Avoid hidden or weird leading/trailing punctuation
  base = base.replace(/^[.\-_ ]+/, "").replace(/[.\-_ ]+$/, "");

  if (!base) base = FALLBACK_BASENAME;
  if (base.length > MAX_BASE_LEN) base = base.slice(0, MAX_BASE_LEN).trim();

  // Final hard safety pass
  base = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").trim();

  return base || FALLBACK_BASENAME;
}

/**
 * Build a stable ASCII filename for Content-Disposition.
 * We intentionally use ASCII-only output because S3 may reject
 * non ISO-8859-1 header values in presigned response headers.
 */
function buildDownloadFilename(filename?: string): string {
  const base = toHeaderSafeBaseName(filename);
  const ext = getSafeExtension(filename);

  // Allow only known upload extensions from your platform.
  // If something unexpected is stored, fall back safely.
  const safeExt =
    ext === "pdf" || ext === "doc" || ext === "docx" ? ext : "";

  return safeExt ? `${base}.${safeExt}` : base;
}

export async function presignGet(key: string, filename?: string) {
  if (!key || typeof key !== "string") {
    throw new Error("Invalid S3 key");
  }

  //const downloadName = buildDownloadFilename(filename);
  const ext = getSafeExtension(filename);
  const downloadName = ext ? `submission.${ext}` : "submission";

  const cmd = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${downloadName}"`
  });

  return getSignedUrl(s3, cmd, { expiresIn: 60 });
}