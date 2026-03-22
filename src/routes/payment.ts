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
  // FAIL-CLOSED: if secret missing, reject webhook
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
 * WEBHOOK (final truth)
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

    // Always log webhook
    await pool.query(
      `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
       VALUES ($1,$2,'payment_webhook',$3,$4::jsonb)`,
      [userId, String(sessionId), eventType, JSON.stringify({ orderId, paymentId, status })]
    );

    // Never downgrade a paid session
    if (String(psQ.rows[0].status) === "paid") {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    const isCaptured = eventType === "payment.captured" || status === "captured";
    const isFailed = eventType === "payment.failed" || status === "failed";

    if (isCaptured) {
      // Dual inquiry (recommended)
      const pay = await rzpRequest<RzpPayment>("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
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
        await pool.query(`UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`, [sessionId]);
        await pool.query(
          `UPDATE orders SET payment_status='paid'
           WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
          [sessionId]
        );
      } else {
        await pool.query(`UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`, [sessionId]);
        await pool.query(
          `UPDATE orders SET payment_status='failed'
           WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
          [sessionId]
        );
      }
    }

    if (isFailed) {
      await pool.query(`UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`, [sessionId]);
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

  const totalAmount = contests.reduce((a, c) => a + Number(c.price || 0), 0);
  return res.render("cart", { contests, totalAmount });
});

/**
 * CREATE ORDERS (pending) grouped by internal paymentId (KNCxxxx)
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

/**
 * EMBEDDED PAYMENT PAGE (DEV SIMULATION)
 */
router.get("/payment/embedded", authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const paymentId = String(req.query.paymentId || "").trim();
    if (!paymentId) return res.status(400).send("Missing paymentId");

    const ordersQ = await pool.query(
      `SELECT o.id, o.amount, o.payment_status, o.payment_id, c.title AS contest_title
       FROM orders o
       JOIN contests c ON c.id = o.contest_id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC`,
      [userId, paymentId]
    );

    if (ordersQ.rows.length === 0) {
      return res.status(404).send("Payment group not found");
    }

    const allPaid = ordersQ.rows.every((r: any) => String(r.payment_status || "") === "paid");
    if (allPaid) {
      return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);
    }

    const totalAmount = ordersQ.rows.reduce(
      (a: number, r: any) => a + Number(r.amount || 0),
      0
    );

    // Reuse existing linked payment session if already created
    const linked = await pool.query(
      `SELECT ps.id, ps.payment_id
       FROM orders o
       JOIN payment_sessions ps ON ps.id = o.payment_session_id
       WHERE o.user_id=$1
         AND o.payment_id=$2
         AND o.payment_session_id IS NOT NULL
       ORDER BY o.created_at ASC
       LIMIT 1`,
      [userId, paymentId]
    );

    let paymentSessionId: string;

    if (linked.rows.length > 0) {
      paymentSessionId = linked.rows[0].id;
    } else {
      const mockGatewayPaymentId = `DEV_${paymentId}`;

      const ps = await pool.query(
        `INSERT INTO payment_sessions (user_id, payment_id, amount, status)
         VALUES ($1,$2,$3,'pending')
         RETURNING id`,
        [userId, mockGatewayPaymentId, totalAmount]
      );

      paymentSessionId = ps.rows[0].id;

      await pool.query(
        `UPDATE orders
         SET payment_session_id=$1
         WHERE user_id=$2
           AND payment_id=$3
           AND payment_session_id IS NULL`,
        [paymentSessionId, userId, paymentId]
      );
    }

    return res.render("payment-embedded", {
      paymentId,
      paymentSessionId,
      orders: ordersQ.rows,
      totalAmount,
    });
  } catch (e) {
    console.error("DEV payment embedded error:", e);
    return res.status(500).send("Unable to open payment page");
  }
});


/**
 * DEV MOCK SUCCESS
 */
router.post("/payment/mock-success", authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const paymentId = String(req.body.paymentId || "").trim();
    if (!paymentId) return res.status(400).send("Missing paymentId");

    const psQ = await pool.query(
      `SELECT ps.id
       FROM orders o
       JOIN payment_sessions ps ON ps.id = o.payment_session_id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC
       LIMIT 1`,
      [userId, paymentId]
    );

    if (psQ.rows.length === 0) {
      return res.status(404).send("Payment session not found");
    }

    const paymentSessionId = psQ.rows[0].id;

    await pool.query("BEGIN");

    await pool.query(
      `UPDATE payment_sessions
       SET status='paid'
       WHERE id=$1 AND status <> 'paid'`,
      [paymentSessionId]
    );

    await pool.query(
      `UPDATE orders
       SET payment_status='paid'
       WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [paymentSessionId]
    );

    // Optional audit-style log in dev
    await pool.query(
      `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
       VALUES ($1,$2,'payment_mock','Simulated payment success',$3::jsonb)`,
      [
        userId,
        String(paymentSessionId),
        JSON.stringify({
          paymentId,
          at: new Date().toISOString(),
          mode: "mock_success",
        }),
      ]
    );

    await pool.query("COMMIT");

    return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("DEV mock success error:", e);
    return res.status(500).send("Failed to simulate payment success");
  }
});

/**
 * DEV MOCK FAILURE
 */
router.post("/payment/mock-failure", authMiddleware, async (req: any, res) => {
  try {
    const userId = req.userId;
    const paymentId = String(req.body.paymentId || "").trim();
    if (!paymentId) return res.status(400).send("Missing paymentId");

    const psQ = await pool.query(
      `SELECT ps.id
       FROM orders o
       JOIN payment_sessions ps ON ps.id = o.payment_session_id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC
       LIMIT 1`,
      [userId, paymentId]
    );

    if (psQ.rows.length === 0) {
      return res.status(404).send("Payment session not found");
    }

    const paymentSessionId = psQ.rows[0].id;

    await pool.query("BEGIN");

    await pool.query(
      `UPDATE payment_sessions
       SET status='failed'
       WHERE id=$1 AND status <> 'paid'`,
      [paymentSessionId]
    );

    await pool.query(
      `UPDATE orders
       SET payment_status='failed'
       WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [paymentSessionId]
    );

    await pool.query(
      `INSERT INTO upload_logs (user_id, order_id, stage, message, meta)
       VALUES ($1,$2,'payment_mock','Simulated payment failure',$3::jsonb)`,
      [
        userId,
        String(paymentSessionId),
        JSON.stringify({
          paymentId,
          at: new Date().toISOString(),
          mode: "mock_failure",
        }),
      ]
    );

    await pool.query("COMMIT");

    return res.status(200).render("payment-failure", {
      retryUrl: `/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`,
      gatewayOrderId: `DEV_${paymentId}`,
      errorCode: "DEV_SIMULATED_FAILURE",
      errorDescription: "This is a simulated failure in the developer environment.",
      errorReason: "Manual test failure",
    });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("DEV mock failure error:", e);
    return res.status(500).send("Failed to simulate payment failure");
  }
});

/**
 * CALLBACK (redirect flow)
 * Signature verify + dual inquiry + mark paid + redirect to bulk checkout
 */
/**
 * CALLBACK (redirect from embedded checkout)
 * Razorpay may hit callback_url as POST (form-urlencoded) or GET (query params) depending on flow.
 * We support BOTH for reliable failure/cancel handling (needed for audit).
 */
async function handleHdfcCallback(req: any, res: any) {
  try {
    // Normalize params from body OR query
    const src: any = (req && req.body && Object.keys(req.body).length) ? req.body : (req.query || {});

    // Success fields
    const razorpay_payment_id = String(src.razorpay_payment_id || "");
    const razorpay_order_id = String(src.razorpay_order_id || "");
    const razorpay_signature = String(src.razorpay_signature || "");

    // Failure fields (Razorpay can send either nested error or bracket-keys)
    const errCode =
      src?.error?.code ||
      src?.["error[code]"] ||
      src?.error_code ||
      "";
    const errDesc =
      src?.error?.description ||
      src?.["error[description]"] ||
      src?.error_description ||
      "";
    const errReason =
      src?.error?.reason ||
      src?.["error[reason]"] ||
      src?.error_reason ||
      "";

    // We need order id to locate session even in failure cases
    const gatewayOrderId = razorpay_order_id || String(src.order_id || "");

    // Lookup session (if possible)
    let sessionId: string | null = null;
    let internalPaymentId: string | null = null;

    if (gatewayOrderId) {
      const psQ = await pool.query(
        `SELECT id, user_id, status
         FROM payment_sessions
         WHERE payment_id=$1
         LIMIT 1`,
        [gatewayOrderId]
      );

      if (psQ.rows.length > 0) {
        sessionId = psQ.rows[0].id;

        const grpQ = await pool.query(
          `SELECT payment_id
           FROM orders
           WHERE payment_session_id=$1
           ORDER BY created_at ASC
           LIMIT 1`,
          [sessionId]
        );
        internalPaymentId = grpQ.rows[0]?.payment_id || null;

        // Always log callback payload for audit
        await pool.query(
          `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
           VALUES ($1,$2,$3::jsonb)`,
          [
            sessionId,
            "callback_payload",
            JSON.stringify({
              at: new Date().toISOString(),
              method: req.method,
              gatewayOrderId,
              body: src,
            }),
          ]
        );

        // If this is a failure/cancel callback, mark failed (but never downgrade paid)
        const alreadyPaid = String(psQ.rows[0].status) === "paid";
        const isFailureSignal =
          Boolean(errCode || errDesc || errReason) ||
          !razorpay_payment_id ||
          !razorpay_signature;

        if (isFailureSignal && !alreadyPaid) {
          await pool.query(
            `UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`,
            [sessionId]
          );
          await pool.query(
            `UPDATE orders SET payment_status='failed'
             WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
            [sessionId]
          );

          const retryUrl = internalPaymentId
            ? `/payment/embedded?paymentId=${encodeURIComponent(internalPaymentId)}`
            : "/dashboard";

          return res.status(200).render("payment-failure", {
            retryUrl,
            gatewayOrderId,
            errorCode: errCode || null,
            errorDescription: errDesc || "Payment cancelled / not completed.",
            errorReason: errReason || null,
          });
        }

        // If already paid, just send user to checkout (idempotent)
        if (alreadyPaid) {
          return res.redirect(
            internalPaymentId
              ? `/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}`
              : "/dashboard"
          );
        }
      }
    }

    // ---- SUCCESS FLOW (must have the 3 fields) ----
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      // If we reached here, we could not map session cleanly. Still show failure UI.
      return res.status(200).render("payment-failure", {
        retryUrl: internalPaymentId
          ? `/payment/embedded?paymentId=${encodeURIComponent(internalPaymentId)}`
          : "/dashboard",
        gatewayOrderId: gatewayOrderId || null,
        errorCode: errCode || "PAYMENT_CANCELLED_OR_FAILED",
        errorDescription: errDesc || "Payment did not complete.",
        errorReason: errReason || null,
      });
    }

    const sigOk = verifyRazorpaySignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });
    if (!sigOk) {
      // Signature mismatch must not be treated as success
      return res.status(400).send("Signature verification failed");
    }

    // Now we MUST have a session
    const psQ2 = await pool.query(
      `SELECT id, user_id, amount, status
       FROM payment_sessions
       WHERE payment_id=$1
       LIMIT 1`,
      [razorpay_order_id]
    );
    if (psQ2.rows.length === 0) return res.status(404).send("Payment session not found");

    const ps = psQ2.rows[0];
    sessionId = ps.id;
    const expectedAmountPaise = Math.round(Number(ps.amount || 0) * 100);

    // Dual inquiry (payment verify)
    const pay = await rzpRequest<RzpPayment>(
      "GET",
      `/v1/payments/${encodeURIComponent(razorpay_payment_id)}`
    );
    const status = String(pay.status || "");
    const amount = Number(pay.amount || 0);

    await pool.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        sessionId,
        "callback_dual_inquiry",
        JSON.stringify({ razorpay_payment_id, razorpay_order_id, status, amount }),
      ]
    );

    if (status !== "captured" || amount !== expectedAmountPaise) {
      await pool.query(
        `UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`,
        [sessionId]
      );
      await pool.query(
        `UPDATE orders SET payment_status='failed'
         WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
        [sessionId]
      );

      const grpQ = await pool.query(
        `SELECT payment_id FROM orders WHERE payment_session_id=$1 ORDER BY created_at ASC LIMIT 1`,
        [sessionId]
      );
      internalPaymentId = grpQ.rows[0]?.payment_id || null;

      const retryUrl = internalPaymentId
        ? `/payment/embedded?paymentId=${encodeURIComponent(internalPaymentId)}`
        : "/dashboard";

      return res.status(200).render("payment-failure", {
        retryUrl,
        gatewayOrderId: razorpay_order_id,
        errorCode: "NOT_CAPTURED",
        errorDescription: "Payment not captured / amount mismatch.",
        errorReason: null,
      });
    }

    // Mark paid
    await pool.query(
      `UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`,
      [sessionId]
    );
    await pool.query(
      `UPDATE orders SET payment_status='paid'
       WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [sessionId]
    );

    const grpQ = await pool.query(
      `SELECT payment_id FROM orders WHERE payment_session_id=$1 ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );
    internalPaymentId = grpQ.rows[0]?.payment_id || null;

    return res.redirect(
      internalPaymentId
        ? `/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}`
        : "/dashboard"
    );
  } catch (e) {
    console.error("HDFC callback error:", e);
    return res.status(500).send("Payment processing error");
  }
}

router.all("/payment/hdfc/callback", handleHdfcCallback);



export default router;
