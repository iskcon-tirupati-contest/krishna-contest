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
  "pdf",
  "doc",
  "docx",
  "jpg",
  "jpeg",
  "png",
  "webp"
]);

const ALLOWED_MIME = new Set([
  // docs
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  // images
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const MAX_ATTEMPTS = 3;

async function getAttemptsUsed(userId: string, orderId: string) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM upload_logs
     WHERE user_id=$1 AND order_id=$2 AND stage='complete_ok'`,
    [userId, orderId]
  );
  return r.rows[0]?.cnt ?? 0;
}


function genInternalPaymentId() {
  return "KNC" + Math.random().toString(36).slice(2, 10).toUpperCase();
}

function normAgeCategory(v: string): "0-25" | "above-25" | null {
  const x = String(v || "").trim();
  if (x === "0-25") return "0-25";
  if (x === "above-25") return "above-25";
  return null;
}

const COMBO_TITLE = "Combo Contest";

const COMBO_CHILD_TITLES = [
  "Bhagavad Gita Essay Writing Contest",
  "Bhagavatam Essay Writing Contest",
  "Ramayana Essay Writing Contest",
  "Krishna Essay Writing Contest",
];

function calcSsrCountFromItems(items: Array<{ quantity?: number }>) {
  const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return Math.floor(totalQty / 4);
}

function parseCartItems(raw: string): Array<{ contestId: string; ageCategory: "0-25" | "above-25" }> {
  const txt = String(raw || "").trim();
  if (!txt) return [];

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const out: Array<{ contestId: string; ageCategory: "0-25" | "above-25" }> = [];
  const seen = new Set<string>();

  for (const part of txt.split(",")) {
    const [contestIdRaw, ageRaw] = String(part || "").split("|");
    const contestId = String(contestIdRaw || "").trim();
    const ageCategory = String(ageRaw || "").trim();

    if (!uuidRe.test(contestId)) continue;
    if (ageCategory !== "0-25" && ageCategory !== "above-25") continue;

    const key = `${contestId}|${ageCategory}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ contestId, ageCategory: ageCategory as "0-25" | "above-25" });
  }

  return out;
}

function getExt(fileName: string) {
  const parts = (fileName || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop()! : "";
}

function isAllowed(contentType: string, fileName: string) {
  const ct = (contentType || "").toLowerCase().trim();
  const ext = getExt(fileName);
  // accept broad mime groups + allowlisted extensions (fallback when mime is empty/wrong)
  if (isAllowedMime(ct)) return true;
  if (ALLOWED_EXT.has(ext)) return true;
  return false;
}

function isAllowedMime(mime: string) {
  if (!mime) return false;
  return ALLOWED_MIME.has(mime);
}

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 5);
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
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
  return res.status(400).json({
    error: `File is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`
  });
}

  if (!isAllowed(String(contentType), String(fileName))) {
  return res.status(400).json({
    error: "Only PDF, DOC, DOCX, JPG, JPEG, PNG, or WEBP files are allowed."
  });
}

  // verify paid order belongs to this user
  const orderRes = await pool.query(
    `SELECT id FROM orders WHERE id=$1 AND user_id=$2 AND payment_status='paid'`,
    [orderId, userId]
  );
  if (orderRes.rows.length === 0) return res.status(403).json({ error: "Invalid order" });


  const attemptsUsed = await getAttemptsUsed(userId, orderId);
  if (attemptsUsed >= MAX_ATTEMPTS) {
    return res.status(400).json({ error: "Max 3 submissions allowed for this contest." });
  }

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

  // attempts limit (server-side enforcement)
  const attemptsUsed = await getAttemptsUsed(String(userId), String(orderId));
  if (attemptsUsed >= MAX_ATTEMPTS) {
    return res.status(400).json({ error: "Max 3 submissions allowed for this contest." });
  }

  // basic validation
 const size = Number(fileSize);
if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
  return res.status(400).json({
    error: `File is too large. Maximum allowed size is ${MAX_UPLOAD_MB} MB.`
  });
}

  if (!keyBelongsToUserOrder(String(key), String(userId), String(orderId))) {
    return res.status(403).json({ error: "Invalid upload key." });
  }

  if (!isAllowed(String(contentType || ""), String(originalName || ""))) {
  return res.status(400).json({
    error: "Only PDF, DOC, DOCX, JPG, JPEG, PNG, or WEBP files are allowed."
  });
}

  // verify paid order belongs to this user
  const orderRes = await pool.query(
    `SELECT id FROM orders WHERE id=$1 AND user_id=$2 AND payment_status='paid'`,
    [orderId, userId]
  );
  if (orderRes.rows.length === 0) return res.status(403).json({ error: "Invalid order" });

  // check submission locked
  const existing = await pool.query(`SELECT id, is_locked FROM submissions WHERE order_id=$1`, [orderId]);
  if (existing.rows.length > 0 && existing.rows[0].is_locked) {
    return res.status(403).json({ error: "Submission locked" });
  }

  // complete multipart in S3
  await completeMultipart(String(key), String(uploadId), parts);

  const publicUrl = `${process.env.S3_PUBLIC_BASE}/${key}`;

  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO submissions (order_id, file_url, file_size, s3_key, content_type, original_name, uploaded_at, last_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,(NOW() AT TIME ZONE 'Asia/Kolkata'), (NOW() AT TIME ZONE 'Asia/Kolkata'))`,
      [orderId, publicUrl, size, key, contentType || null, originalName || null]
    );
  } else {
    await pool.query(
      `UPDATE submissions
       SET file_url=$1,
           file_size=$2,
           s3_key=$3,
           content_type=$4,
           original_name=$5,
           uploaded_at=(NOW() AT TIME ZONE 'Asia/Kolkata'),
           last_updated_at=(NOW() AT TIME ZONE 'Asia/Kolkata')
       WHERE order_id=$6`,
      [publicUrl, size, key, contentType || null, originalName || null, orderId]
    );
  }

  // record successful attempt
  await pool.query(
    `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
     VALUES ($1,$2,'complete_ok','submission saved',$3::jsonb)`,
    [
      userId,
      String(orderId),
      JSON.stringify({ originalName: originalName || null, fileSize: size, contentType: contentType || null })
    ]
  );

  res.json({ ok: true, attemptsUsed: attemptsUsed + 1, attemptsMax: MAX_ATTEMPTS });
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
    `SELECT id, name, email, phone FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );



 const activeContests = await pool.query(
  `SELECT
      id,
      title,
      description,
      price,
      registration_deadline,
      submission_deadline,
      winner_declaration_date,
      image_url,
      prize_details,
      rules,
      age_categories,
      participant_benefits,
      is_active
   FROM contests
   WHERE is_active = true
   ORDER BY
     CASE title
       WHEN 'Ramayana Essay Writing Contest' THEN 1
       WHEN 'Bhagavatam Essay Writing Contest' THEN 2
       WHEN 'Krishna Essay Writing Contest' THEN 3
       WHEN 'Bhagavad Gita Essay Writing Contest' THEN 4
       WHEN 'Combo Contest' THEN 5
       ELSE 999
     END,
     title ASC`
);
  return res.render("dashboard-home", {
    user: userRes.rows[0] || null,
    pending: activeContests.rows,
    activeTab: "home",
  });
});


router.get("/dashboard/my-contests", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userRes = await pool.query(
    `SELECT id, name, email, phone FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );

  const registeredRes = await pool.query(
    `SELECT
        o.id AS order_id,
        o.contest_id,
        o.book_option,
        o.age_category,
        o.created_at AS order_created_at,

        c.title,
        c.description,
        c.price,
        c.registration_deadline,
        c.submission_deadline,
        c.winner_declaration_date,
        c.age_categories,
        c.participant_benefits,
        c.prize_details,
        c.rules,

        CASE
          WHEN c.submission_deadline IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (c.submission_deadline - (NOW() AT TIME ZONE 'Asia/Kolkata')))
        END AS seconds_left,

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
        s.is_locked,

        (SELECT COUNT(*)::int
         FROM upload_logs ul
         WHERE ul.user_id = $1
           AND ul.order_id = o.id::text
           AND ul.stage='complete_ok') AS attempts_used

     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     LEFT JOIN submissions s ON s.order_id = o.id
     WHERE o.user_id = $1
       AND o.payment_status = 'paid'
     ORDER BY o.created_at DESC`,
    [userId]
  );

  return res.render("dashboard-my-contests", {
    user: userRes.rows[0] || null,
    registered: registeredRes.rows,
    activeTab: "my-contests",
  });
});


/**
 * Delivery
 */

router.get("/dashboard/delivery", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const shipmentsRes = await pool.query(
    `
    SELECT
      sh.id AS shipment_id,
      sh.payment_id,
      sh.delivery_mode,
      sh.tracking_id,
      sh.status,
      sh.courier_mode,
      sh.updated_at,
      STRING_AGG(
        DISTINCT COALESCE(si.book_title, c.title),
        ', ' ORDER BY COALESCE(si.book_title, c.title)
      ) AS title
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN contests c ON c.id = o.contest_id
    WHERE o.user_id = $1
      AND o.payment_status = 'paid'
      AND o.book_option = 'book'
    GROUP BY
      sh.id,
      sh.payment_id,
      sh.delivery_mode,
      sh.tracking_id,
      sh.status,
      sh.courier_mode,
      sh.updated_at
    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
    `,
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


router.get("/api/cart/count", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const q = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS count
     FROM cart_items
     WHERE user_id=$1`,
    [userId]
  );

  return res.json({ ok: true, count: Number(q.rows[0]?.count || 0) });
});

router.get("/api/cart/items", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const q = await pool.query(
    `SELECT
        ci.id,
        ci.user_id,
        ci.contest_id,
        ci.age_category,
        ci.quantity,
        c.title,
        c.price,
        c.image_url
     FROM cart_items ci
     JOIN contests c ON c.id = ci.contest_id
     WHERE ci.user_id=$1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  return res.json({ ok: true, items: q.rows });
});

router.post("/api/cart/add", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const contestId = String(req.body.contestId || "").trim();
  const ageCategory = normAgeCategory(String(req.body.ageCategory || ""));

  if (!contestId || !ageCategory) {
    return res.status(400).json({ ok: false, message: "contestId and ageCategory are required." });
  }

  const contestQ = await pool.query(
    `SELECT id FROM contests WHERE id=$1 AND is_active=true LIMIT 1`,
    [contestId]
  );
  if (contestQ.rows.length === 0) {
    return res.status(404).json({ ok: false, message: "Contest not found." });
  }

  await pool.query(
    `INSERT INTO cart_items (user_id, contest_id, age_category, quantity)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (user_id, contest_id, age_category)
     DO UPDATE SET
       quantity = cart_items.quantity + 1,
       updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')`,
    [userId, contestId, ageCategory]
  );

  return res.json({ ok: true });
});

router.post("/api/cart/update", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const cartItemId = String(req.body.cartItemId || "").trim();
  const action = String(req.body.action || "").trim();

  if (!cartItemId || !["plus", "minus", "delete"].includes(action)) {
    return res.status(400).json({ ok: false, message: "Invalid request." });
  }

  const q = await pool.query(
    `SELECT id, quantity
     FROM cart_items
     WHERE id=$1 AND user_id=$2
     LIMIT 1`,
    [cartItemId, userId]
  );

  if (q.rows.length === 0) {
    return res.status(404).json({ ok: false, message: "Cart item not found." });
  }

  const currentQty = Number(q.rows[0].quantity || 0);

  if (action === "delete" || (action === "minus" && currentQty <= 1)) {
    await pool.query(`DELETE FROM cart_items WHERE id=$1 AND user_id=$2`, [cartItemId, userId]);
    return res.json({ ok: true });
  }

  if (action === "plus") {
    await pool.query(
      `UPDATE cart_items
       SET quantity = quantity + 1,
           updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')
       WHERE id=$1 AND user_id=$2`,
      [cartItemId, userId]
    );
    return res.json({ ok: true });
  }

  await pool.query(
    `UPDATE cart_items
     SET quantity = quantity - 1,
         updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')
     WHERE id=$1 AND user_id=$2`,
    [cartItemId, userId]
  );

  return res.json({ ok: true });
});


router.get("/cart-review", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userRes = await pool.query(
    `SELECT id, name, email, phone
     FROM users
     WHERE id=$1
     LIMIT 1`,
    [userId]
  );

  return res.render("cart-review", {
    user: userRes.rows[0] || null
  });
});

router.post("/cart-review/start", authMiddleware, async (_req: any, res) => {
  return res.redirect("/checkout/review");
});


router.get("/dashboard/help", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userRes = await pool.query(
    `SELECT id, name, email, phone FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );

  const ticketsRes = await pool.query(
    `SELECT id, message, status, category, source, transaction_ref, created_at
     FROM feedback_tickets
     WHERE user_id=$1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );

  return res.render("dashboard-help", {
    user: userRes.rows[0] || null,
    tickets: ticketsRes.rows,
    activeTab: "help",
    error: null,
    success: null,
  });
});

// optional alias so old FAQ links still work
router.get("/dashboard/faqs", authMiddleware, (_req: any, res) => {
  return res.redirect("/dashboard/help");
});


router.get("/api/cart/summary", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const q = await pool.query(
    `SELECT quantity
     FROM cart_items
     WHERE user_id=$1`,
    [userId]
  );

  const ssrCount = calcSsrCountFromItems(q.rows || []);
  return res.json({ ok: true, ssrCount });
});

router.post("/api/cart/add-combo", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const ageCategory = normAgeCategory(String(req.body.ageCategory || ""));

  if (!ageCategory) {
    return res.status(400).json({ ok: false, message: "Valid age category is required." });
  }

  const childQ = await pool.query(
    `SELECT id, title
     FROM contests
     WHERE is_active=true
       AND title = ANY($1::text[])
     ORDER BY title ASC`,
    [COMBO_CHILD_TITLES]
  );

  if (childQ.rows.length !== 4) {
    return res.status(400).json({
      ok: false,
      message: "Combo contests are not configured correctly.",
    });
  }

  await pool.query("BEGIN");
  try {
    for (const row of childQ.rows) {
      await pool.query(
        `INSERT INTO cart_items (user_id, contest_id, age_category, quantity)
         VALUES ($1,$2,$3,1)
         ON CONFLICT (user_id, contest_id, age_category)
         DO UPDATE SET
           quantity = cart_items.quantity + 1,
           updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')`,
        [userId, row.id, ageCategory]
      );
    }

    await pool.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("Combo add error:", e);
    return res.status(500).json({
      ok: false,
      message: "Unable to add combo contest right now.",
    });
  }
});

router.post("/api/cart/age", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const cartItemId = String(req.body.cartItemId || "").trim();
  const ageCategory = normAgeCategory(String(req.body.ageCategory || ""));

  if (!cartItemId || !ageCategory) {
    return res.status(400).json({ ok: false, message: "Invalid request." });
  }

  const q = await pool.query(
    `SELECT id, contest_id, quantity
     FROM cart_items
     WHERE id=$1 AND user_id=$2
     LIMIT 1`,
    [cartItemId, userId]
  );

  if (q.rows.length === 0) {
    return res.status(404).json({ ok: false, message: "Cart item not found." });
  }

  const row = q.rows[0];

  // If same contest already exists in target age bucket, merge quantities.
  const clash = await pool.query(
    `SELECT id, quantity
     FROM cart_items
     WHERE user_id=$1
       AND contest_id=$2
       AND age_category=$3
       AND id<>$4
     LIMIT 1`,
    [userId, row.contest_id, ageCategory, cartItemId]
  );

  await pool.query("BEGIN");
  try {
    if (clash.rows.length > 0) {
      await pool.query(
        `UPDATE cart_items
         SET quantity = quantity + $1,
             updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')
         WHERE id=$2 AND user_id=$3`,
        [Number(row.quantity || 0), clash.rows[0].id, userId]
      );

      await pool.query(
        `DELETE FROM cart_items
         WHERE id=$1 AND user_id=$2`,
        [cartItemId, userId]
      );
    } else {
      await pool.query(
        `UPDATE cart_items
         SET age_category=$1,
             updated_at=(NOW() AT TIME ZONE 'Asia/Kolkata')
         WHERE id=$2 AND user_id=$3`,
        [ageCategory, cartItemId, userId]
      );
    }

    await pool.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("Cart age update error:", e);
    return res.status(500).json({
      ok: false,
      message: "Unable to update age category right now.",
    });
  }
});

router.post("/api/cart/clear", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  await pool.query(
    `DELETE FROM cart_items WHERE user_id=$1`,
    [userId]
  );

  return res.json({ ok: true });
});

router.get("/dashboard/public-opinion", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userRes = await pool.query(
    `SELECT id, name, email, phone
     FROM users
     WHERE id=$1
     LIMIT 1`,
    [userId]
  );

  const feedbackRes = await pool.query(
    `SELECT id, answers, submitted_at, updated_at
     FROM public_opinion_feedback
     WHERE user_id=$1
     LIMIT 1`,
    [userId]
  );

  return res.render("dashboard-public-opinion", {
    user: userRes.rows[0] || null,
    existingFeedback: feedbackRes.rows[0] || null,
    activeTab: "help",
  });
});

router.post(
  "/dashboard/public-opinion/submit",
  authMiddleware,
  body("answers").isObject().withMessage("Answers are required."),
  async (req: any, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        ok: false,
        error: errors.array()[0]?.msg || "Invalid request",
      });
    }

    const userId = req.userId;
    const { answers } = req.body;

    try {
      await pool.query(
        `
        INSERT INTO public_opinion_feedback
          (user_id, answers, source, form_version, user_agent, ip_address, submitted_at, updated_at)
        VALUES
          ($1, $2::jsonb, 'dashboard_public_opinion', 'v1', $3, $4, (NOW() AT TIME ZONE 'Asia/Kolkata'), (NOW() AT TIME ZONE 'Asia/Kolkata'))
        ON CONFLICT (user_id)
        DO UPDATE SET
          answers = EXCLUDED.answers,
          source = EXCLUDED.source,
          form_version = EXCLUDED.form_version,
          user_agent = EXCLUDED.user_agent,
          ip_address = EXCLUDED.ip_address,
          updated_at = (NOW() AT TIME ZONE 'Asia/Kolkata')
        `,
        [
          userId,
          JSON.stringify(answers || {}),
          req.get("user-agent") || null,
          req.ip || null,
        ]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("public opinion submit error:", err);
      return res.status(500).json({
        ok: false,
        error: "Unable to save feedback right now.",
      });
    }
  }
);
export default router;