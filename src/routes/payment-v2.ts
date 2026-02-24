// routes/payment.ts
import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";
import crypto from "crypto";
import https from "https";

const router = express.Router();

const RZP_KEY_ID = process.env.RZP_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RZP_KEY_SECRET || "";
const RZP_WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || "";

type RzpOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status?: string;
};

type RzpPayment = {
  id: string;
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
};

function assertRzpEnv() {
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    throw new Error("Missing Razorpay keys. Set RZP_KEY_ID and RZP_KEY_SECRET in .env");
  }
}

function rzpRequest<T>(method: "GET" | "POST", path: string, body?: any): Promise<T> {
  assertRzpEnv();

  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
  const payload = body ? JSON.stringify(body) : "";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.razorpay.com",
        path,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : {};
          } catch {
            // ignore
          }

          if (statusCode >= 200 && statusCode < 300) return resolve(json as T);

          const msg =
            json?.error?.description ||
            json?.error?.message ||
            `Razorpay API error (${statusCode})`;

          return reject(new Error(msg));
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function verifyRazorpaySignature(args: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  assertRzpEnv();
  const base = `${args.razorpay_order_id}|${args.razorpay_payment_id}`;
  const expected = crypto.createHmac("sha256", RZP_KEY_SECRET).update(base).digest("hex");
  const got = String(args.razorpay_signature || "");
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

function verifyWebhookSignature(rawBody: Buffer, signature: string) {
  // Fail CLOSED (production-safe): if secret missing, reject webhook
  if (!RZP_WEBHOOK_SECRET) return false;

  const expected = crypto.createHmac("sha256", RZP_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const got = String(signature || "");

  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

function genPaymentId() {
  return "KNC" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

function parseUuidList(raw: string): string[] {
  const ids = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (ids.length === 0) return [];
  if (!ids.every((x) => uuidRe.test(x))) return [];
  return Array.from(new Set(ids));
}

/**
 * WEBHOOK (recommended for final truth)
 * Requires app.ts: app.use('/payment/hdfc/webhook', express.raw({ type: 'application/json' }))
 */
router.post("/payment/hdfc/webhook", async (req: any, res) => {
  try {
    const sig = String(req.headers["x-razorpay-signature"] || "");
    const rawBody: Buffer = req.body; // Buffer because of express.raw()

    if (!Buffer.isBuffer(rawBody)) return res.status(400).send("Expected raw body");
    if (!sig) return res.status(400).send("Missing x-razorpay-signature");

    const ok = verifyWebhookSignature(rawBody, sig);
    if (!ok) return res.status(400).send("Invalid webhook signature");

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    const eventType = String(event?.event || "");
    const paymentEntity = event?.payload?.payment?.entity;

    const orderId = String(paymentEntity?.order_id || ""); // Razorpay order id
    const paymentId = String(paymentEntity?.id || "");
    const status = String(paymentEntity?.status || "");

    if (!orderId) return res.status(200).json({ ok: true, ignored: true });

    const psQ = await pool.query(
      `SELECT id, user_id, amount, status
       FROM payment_sessions
       WHERE payment_id=$1
       LIMIT 1`,
      [orderId]
    );

    if (psQ.rows.length === 0) return res.status(200).json({ ok: true, unknown_order: true });

    const sessionId = psQ.rows[0].id;
    const userId = psQ.rows[0].user_id;
    const expectedAmountPaise = Math.round(Number(psQ.rows[0].amount || 0) * 100);

    // Always log webhook (audit proof)
    await pool.query(
      `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
       VALUES ($1,$2,'payment_webhook',$3,$4::jsonb)`,
      [userId, String(sessionId), eventType, JSON.stringify({ orderId, paymentId, status })]
    );

    // If already paid, never downgrade later
    if (String(psQ.rows[0].status) === "paid") {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    const isCaptured = eventType === "payment.captured" || status === "captured";
    const isFailed = eventType === "payment.failed" || status === "failed";

    if (isCaptured) {
      // Dual inquiry (strongly recommended)
      const pay = await rzpRequest<RzpPayment>(
        "GET",
        `/v1/payments/${encodeURIComponent(paymentId)}`
      );

      const payStatus = String(pay.status || "");
      const payAmount = Number(pay.amount || 0);

      await pool.query(
        `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
         VALUES ($1,$2,'payment_verify','webhook_dual_inquiry',$3::jsonb)`,
        [
          userId,
          String(sessionId),
          JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, payStatus, payAmount }),
        ]
      );

      if (payStatus === "captured" && payAmount === expectedAmountPaise) {
        // idempotent updates
        await pool.query(`UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`, [
          sessionId,
        ]);
        await pool.query(
          `UPDATE orders SET payment_status='paid'
           WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
          [sessionId]
        );
      } else {
        await pool.query(`UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`, [
          sessionId,
        ]);
        await pool.query(
          `UPDATE orders SET payment_status='failed'
           WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
          [sessionId]
        );
      }
    }

    if (isFailed) {
      // do NOT overwrite paid
      await pool.query(`UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`, [
        sessionId,
      ]);
      await pool.query(
        `UPDATE orders SET payment_status='failed'
         WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
        [sessionId]
      );
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).send("Webhook error");
  }
});

/**
 * CART
 */
router.get("/cart", authMiddleware, async (req: any, res) => {
  const contestIds = parseUuidList(String(req.query.contestIds || ""));
  if (contestIds.length === 0) return res.redirect("/dashboard");

  const q = await pool.query(
    `SELECT id, title, price
     FROM contests
     WHERE is_active=true AND id = ANY($1::uuid[])`,
    [contestIds]
  );

  const contests = q.rows as any[];
  if (contests.length === 0) return res.status(404).send("Contests not found");

  // ✅ Allow repeat participation
  const totalAmount = contests.reduce((a, c) => a + Number(c.price || 0), 0);
  return res.render("cart", { contests, totalAmount });
});

/**
 * CREATE ORDERS (pending) grouped by your internal paymentId (KNCxxxx)
 */
router.post("/payment/start", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const contestIds = parseUuidList(String(req.body.contestIds || ""));
  if (contestIds.length === 0) return res.status(400).send("No contests selected");

  const c = await pool.query(
    `SELECT id, price
     FROM contests
     WHERE is_active=true AND id = ANY($1::uuid[])`,
    [contestIds]
  );

  if (c.rows.length === 0) return res.status(404).send("Contests not found");

  const paymentId = genPaymentId();

  for (const row of c.rows) {
    await pool.query(
      `INSERT INTO orders (user_id, contest_id, amount, payment_status, payment_id, created_at)
       VALUES ($1,$2,$3,'pending',$4,(NOW() AT TIME ZONE 'Asia/Kolkata'))`,
      [userId, row.id, Number(row.price || 0), paymentId]
    );
  }

  return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
});

/**
 * EMBEDDED PAYMENT PAGE
 */
router.get("/payment/embedded", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const paymentId = String(req.query.paymentId || "").trim();
  if (!paymentId) return res.status(400).send("Missing paymentId");

  const ordersQ = await pool.query(
    `SELECT o.id, o.amount, o.payment_status, o.payment_id, c.title AS contest_title
     FROM orders o
     JOIN contests c ON c.id=o.contest_id
     WHERE o.user_id=$1 AND o.payment_id=$2
     ORDER BY o.created_at ASC`,
    [userId, paymentId]
  );

  if (ordersQ.rows.length === 0) return res.status(404).send("Payment group not found");

  const allPaid = ordersQ.rows.every((r: any) => r.payment_status === "paid");
  if (allPaid) return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);

  const totalAmount = ordersQ.rows.reduce((a: number, r: any) => a + Number(r.amount || 0), 0);

  // Reuse or create payment_sessions + razorpay order
  const linked = await pool.query(
    `SELECT ps.id, ps.payment_id AS razorpay_order_id
     FROM orders o
     JOIN payment_sessions ps ON ps.id = o.payment_session_id
     WHERE o.user_id=$1 AND o.payment_id=$2 AND o.payment_session_id IS NOT NULL
     ORDER BY o.created_at ASC
     LIMIT 1`,
    [userId, paymentId]
  );

  let paymentSessionId: string;
  let razorpayOrderId: string;

  if (linked.rows.length > 0) {
    paymentSessionId = linked.rows[0].id;
    razorpayOrderId = linked.rows[0].razorpay_order_id;
  } else {
    const amountPaise = Math.round(Number(totalAmount) * 100);

    const orderResp = await rzpRequest<RzpOrder>("POST", "/v1/orders", {
      amount: amountPaise,
      currency: "INR",
      receipt: paymentId,
      payment_capture: 1,
      notes: { payment_group: paymentId, user_id: userId },
    });

    razorpayOrderId = orderResp.id;

    const ps = await pool.query(
      `INSERT INTO payment_sessions (user_id, payment_id, amount, status)
       VALUES ($1,$2,$3,'pending')
       RETURNING id`,
      [userId, razorpayOrderId, totalAmount]
    );

    paymentSessionId = ps.rows[0].id;

    await pool.query(
      `UPDATE orders
       SET payment_session_id=$1
       WHERE user_id=$2 AND payment_id=$3 AND payment_session_id IS NULL`,
      [paymentSessionId, userId, paymentId]
    );
  }

  const callbackUrl = `${req.protocol}://${req.get("host")}/payment/hdfc/callback`;

  const userQ = await pool.query(`SELECT name, email, phone FROM users WHERE id=$1 LIMIT 1`, [userId]);
  const u = userQ.rows[0] || {};

  return res.render("payment-embedded", {
    paymentId,
    orders: ordersQ.rows,
    totalAmount,
    rzpKeyId: RZP_KEY_ID,
    rzpOrderId: razorpayOrderId,
    rzpAmountPaise: Math.round(Number(totalAmount) * 100),
    callbackUrl,
    prefillName: u.name || "Devotee",
    prefillEmail: u.email || "",
    prefillContact: u.phone || "",
  });
});

/**
 * CALLBACK (redirect flow inside embedded checkout)
 * Signature verify + dual inquiry + mark paid + redirect to bulk checkout
 */
router.post("/payment/hdfc/callback", async (req: any, res) => {
  try {
    const razorpay_payment_id = String(req.body.razorpay_payment_id || "");
    const razorpay_order_id = String(req.body.razorpay_order_id || "");
    const razorpay_signature = String(req.body.razorpay_signature || "");

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).send("Invalid callback payload");
    }

    const sigOk = verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
    if (!sigOk) return res.status(400).send("Signature verification failed");

    const psQ = await pool.query(
      `SELECT id, user_id, amount, status
       FROM payment_sessions
       WHERE payment_id=$1
       LIMIT 1`,
      [razorpay_order_id]
    );

    if (psQ.rows.length === 0) return res.status(404).send("Payment session not found");

    const ps = psQ.rows[0];
    const sessionId = ps.id;
    const userId = ps.user_id;
    const expectedAmountPaise = Math.round(Number(ps.amount || 0) * 100);

    // If already paid, just redirect (idempotent)
    if (String(ps.status) === "paid") {
      const grpQ = await pool.query(
        `SELECT payment_id FROM orders WHERE payment_session_id=$1 ORDER BY created_at ASC LIMIT 1`,
        [sessionId]
      );
      const internalPaymentId = grpQ.rows[0]?.payment_id;
      return res.redirect(internalPaymentId ? `/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}` : "/dashboard");
    }

    const pay = await rzpRequest<RzpPayment>("GET", `/v1/payments/${encodeURIComponent(razorpay_payment_id)}`);
    const status = String(pay.status || "");
    const amount = Number(pay.amount || 0);

    await pool.query(
      `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
       VALUES ($1,$2,'payment_verify','dual_inquiry',$3::jsonb)`,
      [
        userId,
        String(sessionId),
        JSON.stringify({ razorpay_payment_id, razorpay_order_id, status, amount }),
      ]
    );

    if (status !== "captured" || amount !== expectedAmountPaise) {
      await pool.query(`UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`, [sessionId]);
      await pool.query(`UPDATE orders SET payment_status='failed' WHERE payment_session_id=$1 AND payment_status <> 'paid'`, [
        sessionId,
      ]);
      return res.render("payment-failure", { orderId: null, paymentId: razorpay_order_id });
    }

    await pool.query(`UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`, [sessionId]);
    await pool.query(`UPDATE orders SET payment_status='paid' WHERE payment_session_id=$1 AND payment_status <> 'paid'`, [
      sessionId,
    ]);

    const grpQ = await pool.query(
      `SELECT payment_id FROM orders WHERE payment_session_id=$1 ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );

    const internalPaymentId = grpQ.rows[0]?.payment_id;
    return res.redirect(internalPaymentId ? `/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}` : "/dashboard");
  } catch (e) {
    console.error("HDFC callback error:", e);
    return res.status(500).send("Payment processing error");
  }
});

export default router;