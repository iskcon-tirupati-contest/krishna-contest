import express, { Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

import { v4 as uuidv4 } from "uuid";
import { startMultipart, presignPart, completeMultipart, abortMultipart } from "../utils/s3Multipart";
import { presignGet } from "../utils/s3Get";
import { body, validationResult } from "express-validator";

const router = express.Router();

/**
 * Upload allowlist
 */
const ALLOWED_EXT = new Set([
  "pdf", "doc", "docx",
  "mp3", "wav", "aac", "m4a", "ogg",
  "mp4", "m4v", "mov", "webm", "mkv"
]);

const ALLOWED_MIME = new Set([
  // docs
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  // audio
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/aac", "audio/mp4", "audio/m4a", "audio/ogg",
  "application/ogg",

  // video
  "video/mp4", "video/m4v", "video/x-m4v",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "application/octet-stream"
]);

function getExt(fileName: string) {
  const parts = (fileName || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop()! : "";
}

function isAllowed(contentType: string, fileName: string) {
  const ct = (contentType || "").toLowerCase().trim();
  const ext = getExt(fileName);
  if (ALLOWED_MIME.has(ct)) return true;
  if (ALLOWED_EXT.has(ext)) return true;
  return false;
}

const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024);

/**
 * IST deadline enforcement (server-side, mandatory)
 * We treat contests.submission_deadline as IST time.
 */
async function assertSubmissionOpen(orderId: string, userId: string) {
  const q = await pool.query(
    `SELECT
        c.submission_deadline,
        CASE
          WHEN c.submission_deadline IS NULL THEN false
          WHEN (NOW() AT TIME ZONE 'Asia/Kolkata') > c.submission_deadline THEN true
          ELSE false
        END AS deadline_passed
     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     WHERE o.id=$1 AND o.user_id=$2 AND o.payment_status='paid'`,
    [orderId, userId]
  );

  if (q.rows.length === 0) {
    return { ok: false, code: 403, msg: "Invalid order." };
  }

  if (q.rows[0].deadline_passed) {
    return { ok: false, code: 403, msg: "Submission deadline has passed." };
  }

  return { ok: true };
}

function keyBelongsToUserOrder(key: string, userId: string, orderId: string) {
  const prefix = `submissions/2026/user-${userId}/order-${orderId}/`;
  return typeof key === "string" && key.startsWith(prefix);
}

/**
 * Upload failure logs (for support + debugging at scale)
 */
router.post("/dashboard/upload/log", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId, stage, message, meta } = req.body;

  await pool.query(
    `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      userId,
      orderId || null,
      stage || "unknown",
      message || null,
      meta ? JSON.stringify(meta) : null
    ]
  );

  res.json({ ok: true });
});

/**
 * Multipart Upload Routes
 */
router.post("/dashboard/upload/start", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId, fileName, contentType, fileSize } = req.body;

  if (!orderId || !fileName || !contentType || !fileSize) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const gate = await assertSubmissionOpen(String(orderId), String(userId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return res.status(400).json({ error: `Max file size is ${process.env.MAX_UPLOAD_MB || 500}MB` });
  }

  if (!isAllowed(String(contentType), String(fileName))) {
    return res.status(400).json({
      error: `File type not allowed. Allowed: pdf, doc/docx, mp3/wav/aac/m4a/ogg, mp4/m4v/mov/webm/mkv`
    });
  }

  // verify paid order belongs to this user
  const orderRes = await pool.query(
    `SELECT id FROM orders WHERE id=$1 AND user_id=$2 AND payment_status='paid'`,
    [orderId, userId]
  );
  if (orderRes.rows.length === 0) return res.status(403).json({ error: "Invalid order" });

  const ext = getExt(String(fileName)) || "bin";
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = `submissions/2026/user-${userId}/order-${orderId}/${uuidv4()}.${safeExt}`;

  const { uploadId } = await startMultipart(key, String(contentType));
  res.json({ key, uploadId });
});

router.post("/dashboard/upload/presign-parts", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId, key, uploadId, partNumbers } = req.body;

  if (!orderId || !key || !uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const gate = await assertSubmissionOpen(String(orderId), String(userId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (!keyBelongsToUserOrder(String(key), String(userId), String(orderId))) {
    return res.status(403).json({ error: "Invalid upload key." });
  }

  const urls = await Promise.all(
    partNumbers.map(async (pn: number) => ({
      partNumber: pn,
      url: await presignPart(String(key), String(uploadId), Number(pn))
    }))
  );

  res.json({ urls });
});

router.post("/dashboard/upload/complete", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId, key, uploadId, parts, contentType, originalName, fileSize } = req.body;

  if (!orderId || !key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const gate = await assertSubmissionOpen(String(orderId), String(userId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (!keyBelongsToUserOrder(String(key), String(userId), String(orderId))) {
    return res.status(403).json({ error: "Invalid upload key." });
  }

  // verify order belongs to user
  const orderRes = await pool.query(
    `SELECT id FROM orders WHERE id=$1 AND user_id=$2 AND payment_status='paid'`,
    [orderId, userId]
  );
  if (orderRes.rows.length === 0) return res.status(403).json({ error: "Invalid order" });

  // locked?
  const existing = await pool.query(`SELECT id, is_locked FROM submissions WHERE order_id=$1`, [orderId]);
  if (existing.rows.length > 0 && existing.rows[0].is_locked) {
    return res.status(403).json({ error: "Submission locked" });
  }

  // complete multipart in S3
  await completeMultipart(String(key), String(uploadId), parts);

  const publicUrl = `${process.env.S3_PUBLIC_BASE}/${key}`;

  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO submissions (order_id, file_url, s3_key, content_type, original_name, uploaded_at, last_updated_at)
       VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata'), (NOW() AT TIME ZONE 'Asia/Kolkata'))`,
      [orderId, publicUrl, key, contentType || null, originalName || null]
    );
  } else {
    await pool.query(
      `UPDATE submissions
       SET file_url=$1,
           s3_key=$2,
           content_type=$3,
           original_name=$4,
           uploaded_at=(NOW() AT TIME ZONE 'Asia/Kolkata'),
           last_updated_at=(NOW() AT TIME ZONE 'Asia/Kolkata')
       WHERE order_id=$5`,
      [publicUrl, key, contentType || null, originalName || null, orderId]
    );
  }

  res.json({ ok: true });
});

router.post("/dashboard/upload/abort", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId, key, uploadId } = req.body;

  if (!orderId || !key || !uploadId) return res.status(400).json({ error: "Missing fields" });

  const gate = await assertSubmissionOpen(String(orderId), String(userId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (!keyBelongsToUserOrder(String(key), String(userId), String(orderId))) {
    return res.status(403).json({ error: "Invalid upload key." });
  }

  await abortMultipart(String(key), String(uploadId));
  res.json({ ok: true });
});

/**
 * Private download: signed URL (60s) then redirect
 */
router.get("/dashboard/submission/download", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const { orderId } = req.query;

  const q = await pool.query(
    `SELECT s.s3_key, s.original_name
     FROM submissions s
     JOIN orders o ON o.id = s.order_id
     WHERE s.order_id=$1 AND o.user_id=$2`,
    [orderId, userId]
  );

  if (q.rows.length === 0 || !q.rows[0].s3_key) return res.status(404).send("Not found");

  const url = await presignGet(q.rows[0].s3_key, q.rows[0].original_name);
  res.redirect(url);
});

/**
 * Dashboard Home
 */
router.get("/dashboard", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userRes = await pool.query(
    `SELECT id, name, email, phone, role, created_at
     FROM users WHERE id = $1`,
    [userId]
  );

  const activeContests = await pool.query(
    `SELECT * FROM contests
     WHERE is_active = true
     ORDER BY submission_deadline NULLS LAST`
  );

  const registeredRes = await pool.query(
    `SELECT
        o.id AS order_id,
        o.contest_id,
        o.book_option,
        o.created_at AS order_created_at,
        c.title,
        c.description,
        c.price,
        c.submission_deadline,

        CASE
          WHEN c.submission_deadline IS NULL THEN false
          WHEN (NOW() AT TIME ZONE 'Asia/Kolkata') > c.submission_deadline THEN true
          ELSE false
        END AS deadline_passed,

        s.file_url,
        s.s3_key,
        s.content_type,
        s.original_name,
        s.uploaded_at,
        s.last_updated_at,
        s.is_locked

     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     LEFT JOIN submissions s ON s.order_id = o.id
     WHERE o.user_id = $1 AND o.payment_status = 'paid'
     ORDER BY o.created_at DESC`,
    [userId]
  );

  const purchasedIds = registeredRes.rows.map((r: any) => r.contest_id);
  const pending = activeContests.rows.filter((c: any) => !purchasedIds.includes(c.id));

  res.render("dashboard-home", {
    activeTab: "dashboard",
    user: userRes.rows[0],
    registered: registeredRes.rows,
    pending,
  });
});

/**
 * Delivery
 */
router.get("/dashboard/delivery", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const shipmentsRes = await pool.query(
    `SELECT
        o.id AS order_id,
        c.title,
        sh.tracking_id,
        sh.status,
        sh.courier_mode,
        sh.updated_at
     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     LEFT JOIN shipments sh ON sh.order_id = o.id
     WHERE o.user_id = $1
       AND o.payment_status = 'paid'
       AND o.book_option = 'book'
     ORDER BY o.created_at DESC`,
    [userId]
  );

  res.render("dashboard-delivery", {
    activeTab: "delivery",
    shipments: shipmentsRes.rows,
  });
});

/**
 * FAQs
 */
router.get("/dashboard/faqs", authMiddleware, async (_req: any, res) => {
  res.render("dashboard-faqs", { activeTab: "faqs" });
});




export default router;
