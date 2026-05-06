// src/routes/cashfree.ts
// All Cashfree payment logic: webhook, callback, payment selection page, COD confirmation.
//
// Register in app.ts:
//   import cashfreeRouter from "./routes/cashfree";
//   app.use("/", cashfreeRouter);
//
// Raw body middleware (must be BEFORE express.json()):
//   app.use("/payment/cashfree/webhook", express.raw({ type: "application/json" }));

import express from "express";
import https  from "https";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

const COD_SURCHARGE = 46; // ₹46 handling charge for Cash on Delivery

// ═══════════════════════════════════════════════════════════════════════════════
// ──  CASHFREE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify a Cashfree payment link status via their API.
 * linkId here is the full "CF_KNCxxxx" string we stored in payment_sessions.payment_id.
 *
 * Possible link_status values: ACTIVE | PAID | CANCELLED | EXPIRED | PARTIALLY_PAID
 */
async function getCashfreeLinkStatus(linkId: string): Promise<string> {
  const CF_APP_ID     = process.env.CF_APP_ID     || "";
  const CF_SECRET_KEY = process.env.CF_SECRET_KEY || "";
  const CF_HOST       = process.env.CF_HOST       || "sandbox.cashfree.com";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CF_HOST,
        path:     `/pg/links/${encodeURIComponent(linkId)}`,
        method:   "GET",
        headers: {
          "x-client-id":    CF_APP_ID,
          "x-client-secret": CF_SECRET_KEY,
          "x-api-version":  "2023-08-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const sc = res.statusCode || 0;
          let json: any = null;
          try { json = JSON.parse(data); } catch {}
          if (sc >= 200 && sc < 300) {
            return resolve(String(json?.link_status || ""));
          }
          const msg = json?.message || data.slice(0, 200);
          return reject(new Error(`Cashfree status API error (${sc}): ${msg}`));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Cashfree: Create a Payment Link and return the redirect URL.
 */
async function createCashfreeLink(opts: {
  linkId: string;
  amount: number;
  name: string;
  phone: string;
  internalPaymentId: string;
}): Promise<string> {
  const CF_APP_ID     = process.env.CF_APP_ID     || "";
  const CF_SECRET_KEY = process.env.CF_SECRET_KEY || "";
  const CF_HOST       = process.env.CF_HOST       || "api.cashfree.com";
  const APP_BASE_URL  = process.env.APP_BASE_URL  || "https://krishnacontest.org";

  if (!CF_APP_ID || !CF_SECRET_KEY) {
    throw new Error("Cashfree credentials missing. Set CF_APP_ID and CF_SECRET_KEY in .env");
  }

  const returnUrl =
    `${APP_BASE_URL}/payment/cashfree/callback` +
    `?paymentId=${encodeURIComponent(opts.internalPaymentId)}`;

  const bodyObj = {
    link_id:       opts.linkId,
    link_amount:   opts.amount,
    link_currency: "INR",
    link_purpose:  "ISKCON Essay Contest Registration",
    customer_details: {
      customer_name:  opts.name,
      customer_phone: `+91${opts.phone}`,
    },
    link_notify:         { send_sms: false, send_email: false },
    link_auto_reminders: false,
    link_meta: { return_url: returnUrl },
  };

  const bodyStr = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CF_HOST,
        path:     "/pg/links",
        method:   "POST",
        headers: {
          "Content-Type":    "application/json",
          "x-client-id":    CF_APP_ID,
          "x-client-secret": CF_SECRET_KEY,
          "x-api-version":  "2023-08-01",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const sc = res.statusCode || 0;
          let json: any = null;
          try { json = JSON.parse(data); } catch {}
          if (sc >= 200 && sc < 300) {
            if (json?.link_url) return resolve(json.link_url as string);
            return reject(new Error("Cashfree: no link_url in response"));
          }
          const msg = json?.message || json?.error || data.slice(0, 200);
          return reject(new Error(`Cashfree API error (${sc}): ${msg}`));
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * When Cashfree webhook sends their internal CFPay_xxx order_id, call their
 * Orders API to retrieve the associated link_id (our CF_KNCxxxx).
 */
async function getCashfreeOrderLinkId(cfOrderId: string): Promise<string> {
  const CF_APP_ID     = process.env.CF_APP_ID     || "";
  const CF_SECRET_KEY = process.env.CF_SECRET_KEY || "";
  const CF_HOST       = process.env.CF_HOST       || "api.cashfree.com";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CF_HOST,
        path:     `/pg/orders/${encodeURIComponent(cfOrderId)}`,
        method:   "GET",
        headers: {
          "x-client-id":     CF_APP_ID,
          "x-client-secret": CF_SECRET_KEY,
          "x-api-version":   "2023-08-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          console.log(`CF Orders API response for ${cfOrderId}:`, data.slice(0, 500));
          let json: any = null;
          try { json = JSON.parse(data); } catch {}
          // Look for our link_id in common response fields
          const linkId = String(
            json?.link_id              ||
            json?.order_tags?.link_id  ||
            json?.order_meta?.link_id  ||
            ""
          ).trim();
          resolve(linkId);
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Verify a Cashfree webhook signature (2025-01-01 format).
 *
 * Cashfree 2025-01-01 signs webhooks using your CF_SECRET_KEY (same as API secret).
 * There is NO separate webhook secret for this version.
 *
 * Formula:  base64( HMAC-SHA256( timestamp + rawBody, CF_SECRET_KEY ) )
 * Headers:  x-webhook-signature, x-webhook-timestamp
 */
function verifyCashfreeWebhookSignature(
  rawBody:   Buffer,
  signature: string,
  timestamp: string
): boolean {
  // For 2025-01-01, Cashfree uses CF_SECRET_KEY directly.
  // Set CF_WEBHOOK_SECRET = same value as CF_SECRET_KEY in your .env
  const secret = process.env.CF_WEBHOOK_SECRET || process.env.CF_SECRET_KEY || "";
  if (!secret) {
    console.error("Cashfree webhook: CF_WEBHOOK_SECRET / CF_SECRET_KEY not set");
    return false; // FAIL-CLOSED
  }

  const payload  = timestamp + rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64");
  const got      = String(signature || "");

  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

/**
 * CASHFREE WEBHOOK  (2025-01-01 payload format)
 *
 * Events subscribed: "success payment", "payment verification update"
 *
 * 2025-01-01 payload shape (success payment):
 * {
 *   "type": "PAYMENT_SUCCESS_WEBHOOK",
 *   "data": {
 *     "order":   { "order_id": "CF_KNCxxxx", "order_status": "PAID", ... },
 *     "payment": { "cf_payment_id": 123, "payment_status": "SUCCESS", ... }
 *   },
 *   "event_time": "..."
 * }
 *
 * payment_status values: SUCCESS | FAILED | USER_DROPPED | NOT_ATTEMPTED | CANCELLED
 *
 * In app.ts — add BEFORE express.json():
 *   app.use('/payment/cashfree/webhook', express.raw({ type: 'application/json' }))
 */
router.post("/payment/cashfree/webhook", async (req: any, res) => {
  try {
    const sig:       string = String(req.headers["x-webhook-signature"] || "");
    const timestamp: string = String(req.headers["x-webhook-timestamp"] || "");
    const rawBody:   Buffer = req.body;

    if (!Buffer.isBuffer(rawBody)) return res.status(400).send("Expected raw body");
    if (!sig || !timestamp)        return res.status(400).send("Missing webhook headers");

    const ok = verifyCashfreeWebhookSignature(rawBody, sig, timestamp);
    if (!ok) {
      console.warn("Cashfree webhook: invalid signature", { sig, timestamp });
      return res.status(400).send("Invalid webhook signature");
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    // ── Parse 2025-01-01 payload ──────────────────────────────────────────────
    const eventType = String(event?.type || "").toUpperCase();

    // Always log the FULL raw payload for debugging
    console.log("Cashfree webhook raw data:", JSON.stringify(event?.data || {}).slice(0, 800));

    // payment_status: SUCCESS | FAILED | USER_DROPPED | NOT_ATTEMPTED | CANCELLED
    const paymentStatus = String(event?.data?.payment?.payment_status || "").toUpperCase();
    const orderStatus   = String(event?.data?.order?.order_status     || "").toUpperCase();

    // Our CF_KNCxxxx link_id is in order_tags.link_id (confirmed from live payload).
    // Cashfree also sends their internal CFPay_xxx in order.order_id — don't use that.
    const cfOrderId = String(event?.data?.order?.order_id || "").trim(); // CFPay_xxx (their id)
    let linkId = String(
      event?.data?.order?.order_tags?.link_id  ||  // ✅ confirmed: our CF_KNCxxxx is here
      event?.data?.link?.link_id               ||  // keep as fallback
      event?.data?.order?.link_id              ||  // keep as fallback
      ""
    ).trim();

    console.log(`Cashfree webhook: type=${eventType} linkId=${linkId} cfOrderId=${cfOrderId} paymentStatus=${paymentStatus}`);

    if (!linkId) {
      console.warn("Cashfree webhook: no identifiable id in payload");
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Look up payment session — first try the extracted linkId directly
    let psQ = await pool.query(
      `SELECT id, status FROM payment_sessions WHERE payment_id=$1 LIMIT 1`,
      [linkId]
    );

    // If not found AND we have a CFPay_xxx order id, ask CF API for the linked link_id
    if (psQ.rows.length === 0 && cfOrderId && cfOrderId !== linkId) {
      try {
        const cfOrderLinkId = await getCashfreeOrderLinkId(cfOrderId);
        if (cfOrderLinkId) {
          console.log(`Cashfree webhook: resolved cfOrderId=${cfOrderId} → linkId=${cfOrderLinkId}`);
          linkId = cfOrderLinkId;
          psQ = await pool.query(
            `SELECT id, status FROM payment_sessions WHERE payment_id=$1 LIMIT 1`,
            [linkId]
          );
        }
      } catch (e) {
        console.error("Cashfree webhook: CF Orders API lookup failed:", e);
      }
    }

    if (psQ.rows.length === 0) {
      console.warn(`Cashfree webhook: session not found for linkId=${linkId} cfOrderId=${cfOrderId}`);
      return res.status(200).json({ ok: true, unknown_link: true });
    }

    const sessionId = psQ.rows[0].id;

    // Always log the full raw event for audit
    await pool.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        sessionId,
        `cf_${eventType.toLowerCase()}`,
        JSON.stringify({
          at: new Date().toISOString(),
          linkId,
          eventType,
          paymentStatus,
          orderStatus,
        }),
      ]
    );

    // Never downgrade a paid session
    if (String(psQ.rows[0].status) === "paid") {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    const isSuccess = paymentStatus === "SUCCESS" || orderStatus === "PAID";
    const isFailure = ["FAILED", "USER_DROPPED", "NOT_ATTEMPTED", "CANCELLED"].includes(paymentStatus);

    if (isSuccess) {
      await pool.query(
        `UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`,
        [sessionId]
      );
      await pool.query(
        `UPDATE orders SET payment_status='paid'
         WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
        [sessionId]
      );
      console.log(`Cashfree webhook: marked PAID for linkId=${linkId}`);
    } else if (isFailure) {
      await pool.query(
        `UPDATE payment_sessions SET status='failed' WHERE id=$1 AND status <> 'paid'`,
        [sessionId]
      );
      await pool.query(
        `UPDATE orders SET payment_status='failed'
         WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
        [sessionId]
      );
      console.log(`Cashfree webhook: marked FAILED for linkId=${linkId} (${paymentStatus})`);
    } else {
      console.log(`Cashfree webhook: no-op for paymentStatus=${paymentStatus}`);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Cashfree webhook error:", e);
    return res.status(500).send("Webhook error");
  }
});

/**
 * CASHFREE CALLBACK  (return_url after payment)
 *
 * Cashfree redirects user here after payment attempt.
 * URL set in directRegistration.ts as:
 *   /payment/cashfree/callback?paymentId=KNCxxxx
 *
 * Cashfree may also append its own params: link_id, link_status, referenceId
 * We verify the actual status via API (don't trust query params alone).
 */
router.get("/payment/cashfree/callback", async (req: any, res) => {
  const internalPaymentId = String(req.query.paymentId || "").trim(); // our KNCxxxx
  const cfLinkId          = `CF_${internalPaymentId}`;

  // Guard: bad/missing paymentId
  if (!internalPaymentId) {
    return res.render("payment-failure", {
      retryUrl:         "/dashboard",
      gatewayOrderId:   null,
      errorCode:        "MISSING_PAYMENT_ID",
      errorDescription: "Payment reference is missing. Please contact support.",
      errorReason:      null,
    });
  }

  try {
    // Look up payment session
    const psQ = await pool.query(
      `SELECT id, status
       FROM payment_sessions
       WHERE payment_id=$1
       LIMIT 1`,
      [cfLinkId]
    );

    if (psQ.rows.length === 0) {
      return res.render("payment-failure", {
        retryUrl:         "/dashboard",
        gatewayOrderId:   cfLinkId,
        errorCode:        "SESSION_NOT_FOUND",
        errorDescription: "Payment session not found. Please contact support.",
        errorReason:      null,
      });
    }

    const sessionId = psQ.rows[0].id;

    // Already paid (webhook arrived first or double-callback) → go straight to success
    if (String(psQ.rows[0].status) === "paid") {
      return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}`);
    }

    // Log the callback for audit
    await pool.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,'cf_callback',$2::jsonb)`,
      [
        sessionId,
        JSON.stringify({
          at:              new Date().toISOString(),
          internalPaymentId,
          cfLinkId,
          cfLinkStatus:    req.query.link_status   || null,
          cfReferenceId:   req.query.referenceId   || null,
        }),
      ]
    );

    // Verify with Cashfree API — don't trust redirect params alone
    let linkStatus: string;
    try {
      linkStatus = await getCashfreeLinkStatus(cfLinkId);
    } catch (e) {
      console.error("Cashfree status check failed:", e);
      // Can't verify right now — show a soft error with "try again" option
      return res.render("payment-failure", {
        retryUrl:         `/payment/cashfree/callback?paymentId=${encodeURIComponent(internalPaymentId)}`,
        gatewayOrderId:   cfLinkId,
        errorCode:        "VERIFY_FAILED",
        errorDescription: "Unable to verify payment status. Tap retry in a moment.",
        errorReason:      null,
      });
    }

    if (linkStatus === "PAID") {
      await pool.query(
        `UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`,
        [sessionId]
      );
      await pool.query(
        `UPDATE orders SET payment_status='paid'
         WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
        [sessionId]
      );
      return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(internalPaymentId)}`);
    }

    // CANCELLED / EXPIRED / ACTIVE (timed out) / PARTIALLY_PAID
    // ⚠️  Do NOT mark orders 'failed' here — user may have pressed back and wants to retry.
    // The webhook (after its 3 retries exhaust) is the authoritative source for failures.
    // Just show a soft retry page; orders stay 'pending' so user can re-select payment.
    return res.render("payment-failure", {
      retryUrl:         `/payment/select?paymentId=${encodeURIComponent(internalPaymentId)}`,
      gatewayOrderId:   cfLinkId,
      errorCode:        linkStatus || "NOT_PAID",
      errorDescription: "Payment was not completed. Please try again or choose a different method.",
      errorReason:      null,
    });
  } catch (e) {
    console.error("Cashfree callback error:", e);
    return res.status(500).send("Payment processing error");
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ──  PAYMENT SELECTION PAGE  (new flow — replaces inline payment mode on form)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /payment/select?paymentId=KNCxxxx
 * Shows the 3-way payment option page after registration form is submitted.
 */
router.get("/payment/select", authMiddleware, async (req: any, res) => {
  try {
    const userId    = req.userId;
    const paymentId = String(req.query.paymentId || "").trim();
    if (!paymentId) return res.status(400).send("Missing paymentId");

    // Load orders + shipment delivery mode
    const ordersQ = await pool.query(
      `SELECT o.id, o.amount, o.payment_status, o.book_option, o.created_at, c.title AS contest_title
       FROM orders o
       JOIN contests c ON c.id = o.contest_id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC`,
      [userId, paymentId]
    );

    if (ordersQ.rows.length === 0) {
      return res.status(404).send("Payment group not found");
    }

    // Already paid → go to success
    const allPaid = ordersQ.rows.every((r: any) => String(r.payment_status) === "paid");
    if (allPaid) {
      return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);
    }

    // Fetch delivery mode from shipment
    // Donation orders have no shipment row — treat missing shipment as "donate" (online pay only)
    const shipQ = await pool.query(
      `SELECT delivery_mode FROM shipments WHERE payment_id=$1 LIMIT 1`,
      [paymentId]
    );
    const deliveryMode = String(shipQ.rows[0]?.delivery_mode || "donate").trim();

    // All delivery modes now come through payment-select
    // COD is shown only for home_delivery — template hides it for others
    const isHomeDelivery = deliveryMode === "home_delivery";

    const baseAmount = ordersQ.rows.reduce(
      (s: number, r: any) => s + Number(r.amount || 0), 0
    );

    // Donation orders (donate delivery mode) — COD not applicable
    const isDonation = ordersQ.rows.every((r: any) => String(r.book_option || '') === 'donation');

    // Cashfree visibility — set CASHFREE_ENABLED=false to hide
    const cashfreeEnabled = (process.env.CASHFREE_ENABLED || 'true').toLowerCase() !== 'false';

    // COD visibility — set COD_ENABLED=false to hide (default: false for now)
    const codEnabled = (process.env.COD_ENABLED || 'false').toLowerCase() !== 'false';

    // Detect if this is a resumed order (created more than 2 min ago)
    const oldestOrder = ordersQ.rows[0];
    const isResumed = oldestOrder &&
      (Date.now() - new Date((oldestOrder as any).created_at || 0).getTime()) > 2 * 60 * 1000;

    return res.render("payment-select", {
      paymentId,
      orders:         ordersQ.rows,
      baseAmount,
      codSurcharge:   COD_SURCHARGE,
      isDonation,
      cashfreeEnabled,
      codEnabled,
      isResumed:      Boolean(isResumed),
      isHomeDelivery, // COD only shown for home_delivery
    });
  } catch (e) {
    console.error("GET /payment/select error:", e);
    return res.status(500).send("Unable to load payment page");
  }
});

/**
 * POST /payment/select
 * Handles the chosen payment mode and branches accordingly.
 */
router.post("/payment/select", authMiddleware, async (req: any, res) => {
  try {
    const userId      = req.userId;
    const paymentId   = String(req.body.paymentId    || "").trim();
    const paymentMode = String(req.body.payment_mode || "").trim().toLowerCase();

    if (!paymentId) return res.status(400).send("Missing paymentId");
    if (!["razorpay", "cashfree", "cod"].includes(paymentMode)) {
      return res.status(400).send("Invalid payment mode");
    }

    // Load orders + user info
    const ordersQ = await pool.query(
      `SELECT o.id, o.amount, o.payment_status, o.payment_session_id, c.title AS contest_title
       FROM orders o
       JOIN contests c ON c.id = o.contest_id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC`,
      [userId, paymentId]
    );

    if (ordersQ.rows.length === 0) return res.status(404).send("Orders not found");

    const allPaid = ordersQ.rows.every((r: any) => String(r.payment_status) === "paid");
    if (allPaid) {
      return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);
    }

    // If a payment session already exists for this group (user re-selected), reuse/update
    // For safety, only re-create if still pending
    const existingSession = ordersQ.rows.find((r: any) => r.payment_session_id);

    const userQ = await pool.query(`SELECT name, phone FROM users WHERE id=$1`, [userId]);
    const user  = userQ.rows[0];
    if (!user) return res.status(404).send("User not found");

    const baseAmount = ordersQ.rows.reduce(
      (s: number, r: any) => s + Number(r.amount || 0), 0
    );

    // ── RAZORPAY ──────────────────────────────────────────────────────────────
    if (paymentMode === "razorpay") {
      // If user previously chose COD and is now switching to Razorpay:
      // 1. Cancel the COD session so it disappears from the COD admin tab
      // 2. Re-link orders to NULL so payment/embedded can create a fresh Razorpay session
      // 3. Reset payment_status from cod_pending → pending so Razorpay webhook can mark paid
      // (payment.ts itself is untouched — all cleanup happens here before the redirect)
      await pool.query(
        `UPDATE payment_sessions
         SET status = 'cancelled'
         WHERE payment_id = 'COD_' || $1
           AND status = 'cod_pending'`,
        [paymentId]
      );

      await pool.query(
        `UPDATE orders
         SET payment_session_id = NULL,
             payment_status = CASE
               WHEN payment_status = 'cod_pending' THEN 'pending'
               ELSE payment_status
             END
         WHERE user_id = $1
           AND payment_id = $2
           AND payment_status = 'cod_pending'`,
        [userId, paymentId]
      );

      return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
    }

    // ── CASHFREE ──────────────────────────────────────────────────────────────
    if (paymentMode === "cashfree") {
      const cfLinkId = `CF_${paymentId}`;

      // Check if CF session already created (user came back and re-selected cashfree)
      const existingCfQ = await pool.query(
        `SELECT id, status FROM payment_sessions WHERE payment_id=$1 LIMIT 1`,
        [cfLinkId]
      );

      let cfLinkUrl: string;

      if (existingCfQ.rows.length > 0 && String(existingCfQ.rows[0].status) === "paid") {
        return res.redirect(`/checkout/bulk?paymentId=${encodeURIComponent(paymentId)}`);
      }

      // Create new CF link (or re-create if expired — Cashfree will error on duplicate link_id,
      // so we append a suffix for retries)
      let linkId = cfLinkId;
      if (existingCfQ.rows.length > 0) {
        // Previous CF session exists but not paid — create a new link with suffix
        const suffix = Date.now().toString(36).slice(-4).toUpperCase();
        linkId = `${cfLinkId}_${suffix}`;
      }

      cfLinkUrl = await createCashfreeLink({
        linkId,
        amount: baseAmount,
        name:  String(user.name  || ""),
        phone: String(user.phone || ""),
        internalPaymentId: paymentId,
      });

      const ps = await pool.query(
        `INSERT INTO payment_sessions (user_id, payment_id, amount, status)
         VALUES ($1,$2,$3,'pending')
         RETURNING id`,
        [userId, linkId, baseAmount]
      );

      // Cancel any COD session if user switched from COD → Cashfree
      await pool.query(
        `UPDATE payment_sessions SET status='cancelled'
         WHERE payment_id='COD_' || $1 AND status='cod_pending'`,
        [paymentId]
      );

      // Link orders — also re-link if previously pointed to a COD session
      await pool.query(
        `UPDATE orders
         SET payment_session_id=$1,
             payment_status = CASE WHEN payment_status='cod_pending' THEN 'pending' ELSE payment_status END
         WHERE user_id=$2
           AND payment_id=$3
           AND (
             payment_status='pending'
             OR (
               payment_status='cod_pending'
               AND EXISTS (
                 SELECT 1 FROM payment_sessions ps
                 WHERE ps.id = orders.payment_session_id
                   AND ps.payment_id LIKE 'COD_%'
               )
             )
           )`,
        [ps.rows[0].id, userId, paymentId]
      );

      return res.redirect(cfLinkUrl);
    }

    // ── COD ───────────────────────────────────────────────────────────────────
    if (paymentMode === "cod") {
      const codTotal   = baseAmount + COD_SURCHARGE;
      const codLinkId  = `COD_${paymentId}`;

      // Idempotent: if COD session already exists (user pressed back + reselected), reuse it
      const existing = await pool.query(
        `SELECT id, status FROM payment_sessions WHERE payment_id=$1 LIMIT 1`,
        [codLinkId]
      );

      if (existing.rows.length > 0) {
        // Already exists — just redirect to confirm page
        return res.redirect(`/payment/cod-confirm?paymentId=${encodeURIComponent(paymentId)}`);
      }

      await pool.query("BEGIN");

      // COD: create session as 'cod_pending' — admin dispatches book, marks paid after cash collected
      const ps = await pool.query(
        `INSERT INTO payment_sessions (user_id, payment_id, amount, status)
         VALUES ($1,$2,$3,'cod_pending')
         RETURNING id`,
        [userId, codLinkId, codTotal]
      );

      await pool.query(
        `UPDATE orders
         SET payment_session_id=$1, payment_status='cod_pending'
         WHERE user_id=$2 AND payment_id=$3 AND payment_status='pending'`,
        [ps.rows[0].id, userId, paymentId]
      );

      await pool.query("COMMIT");

      return res.redirect(`/payment/cod-confirm?paymentId=${encodeURIComponent(paymentId)}`);
    }

    return res.status(400).send("Unhandled payment mode");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("POST /payment/select error:", e);
    return res.status(500).send("Payment selection error");
  }
});

/**
 * GET /payment/cod-confirm
 * Shows the COD order placed confirmation page.
 */
router.get("/payment/cod-confirm", authMiddleware, async (req: any, res) => {
  try {
    const userId    = req.userId;
    const paymentId = String(req.query.paymentId || "").trim();
    if (!paymentId) return res.status(400).send("Missing paymentId");

    const ordersQ = await pool.query(
      `SELECT o.id, o.amount, c.title AS contest_title,
              si.book_title, si.book_language
       FROM orders o
       JOIN contests c ON c.id = o.contest_id
       LEFT JOIN shipment_items si ON si.order_id = o.id
       WHERE o.user_id=$1 AND o.payment_id=$2
       ORDER BY o.created_at ASC`,
      [userId, paymentId]
    );

    if (ordersQ.rows.length === 0) return res.status(404).send("Orders not found");

    const shipQ = await pool.query(
      `SELECT * FROM shipments WHERE payment_id=$1 LIMIT 1`,
      [paymentId]
    );

    const baseAmount = ordersQ.rows.reduce(
      (s: number, r: any) => s + Number(r.amount || 0), 0
    );

    return res.render("payment-cod-confirm", {
      paymentId,
      orders:       ordersQ.rows,
      shipment:     shipQ.rows[0] || null,
      baseAmount,
      codSurcharge: COD_SURCHARGE,
      codTotal:     baseAmount + COD_SURCHARGE,
    });
  } catch (e) {
    console.error("GET /payment/cod-confirm error:", e);
    return res.status(500).send("Unable to load confirmation page");
  }
});


export default router;