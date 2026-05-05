// src/routes/paymentComplaint.ts
import express from "express";
import { pool } from "../config/db";

const router = express.Router();

const norm = (v: any) => String(v ?? "").trim();

/**
 * Auto-raise a complaint from the payment failure page.
 * Looks up payment_session by Razorpay order_id, fetches user + amount,
 * and creates a feedback_tickets row. Idempotent per gatewayOrderId.
 *
 * No auth required — the gatewayOrderId itself is the bearer of legitimacy
 * (random 16-char Razorpay ID, only known to someone who actually attempted
 * payment). Idempotency prevents spam.
 */
router.post("/payment/auto-complaint", async (req, res) => {
  try {
    const gatewayOrderId    = norm(req.body.gatewayOrderId);
    const errorCode         = norm(req.body.errorCode);
    const errorDescription  = norm(req.body.errorDescription);
    const errorReason       = norm(req.body.errorReason);
    const reasonCategory    = norm(req.body.reasonCategory) || "generic";

    if (!gatewayOrderId) {
      return res.status(400).json({
        ok: false,
        message: "Missing payment reference.",
      });
    }

    // Look up payment session, user, amount, and internal payment id
    const lookup = await pool.query(
      `SELECT
          ps.id            AS session_id,
          ps.user_id       AS user_id,
          ps.amount        AS amount,
          ps.status        AS session_status,
          u.name           AS user_name,
          u.phone          AS phone,
          (SELECT payment_id FROM orders
            WHERE payment_session_id = ps.id
            ORDER BY created_at ASC LIMIT 1) AS internal_payment_id
       FROM payment_sessions ps
       LEFT JOIN users u ON u.id = ps.user_id
       WHERE ps.payment_id = $1
       LIMIT 1`,
      [gatewayOrderId]
    );

    if (lookup.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "We couldn't find this payment record. Please use the regular complaint form.",
      });
    }

    const row = lookup.rows[0];

    // Only allow auto-complaint on actually-failed sessions
    // (prevents creating tickets on paid or pending sessions)
    if (row.session_status === "paid") {
      return res.status(400).json({
        ok: false,
        message: "This payment has already been marked as paid. No complaint needed.",
      });
    }

    // Idempotency: don't create duplicate tickets for the same payment
    const dupQ = await pool.query(
      `SELECT id FROM feedback_tickets
        WHERE transaction_ref = $1
          AND source = 'payment_failure_auto'
        LIMIT 1`,
      [gatewayOrderId]
    );

    if (dupQ.rows.length > 0) {
      return res.json({
        ok: true,
        already: true,
        ticketRef: String(dupQ.rows[0].id).slice(0, 8).toUpperCase(),
        message:
          "We've already registered a complaint for this payment. Our team will contact you within 24 hours.",
      });
    }

    // Build admin-friendly subject and message
    const subjectLabel: Record<string, string> = {
      timeout:      "Payment Failure — UPI Timeout",
      insufficient: "Payment Failure — Insufficient Funds",
      declined:     "Payment Failure — Bank Declined",
      cancelled:    "Payment Failure — User Cancelled",
      wrong_pin:    "Payment Failure — Incorrect PIN",
      generic:      "Payment Failure — Auto-raised",
    };

    const subject =
      subjectLabel[reasonCategory] || subjectLabel.generic;

    const message =
`[AUTO-RAISED FROM PAYMENT FAILURE PAGE]

A customer reported a payment failure and requested complaint registration.
This complaint was created automatically from the failure page.

PAYMENT DETAILS
- Internal Payment ID : ${row.internal_payment_id || "(not assigned)"}
- Razorpay Order ID   : ${gatewayOrderId}
- Amount              : ₹${Number(row.amount || 0)}
- Customer Name       : ${row.user_name || "(not on file)"}
- Customer Phone      : ${row.phone || "(not on file)"}

FAILURE INFO
- Reason Category     : ${reasonCategory}
- Error Description   : ${errorDescription || "(not provided)"}
- Error Code          : ${errorCode || "(not provided)"}
- Error Reason        : ${errorReason || "(not provided)"}

ACTION REQUIRED
Please verify whether the customer's account was debited and:
  1. If debit was an actual failure → confirm bank auto-refund will reach them in 5-7 days
  2. If debit succeeded but didn't reach us → reconcile and mark registration as Paid
  3. If neither, reach out to customer with next steps

Customer expects resolution within 24 hours.`;

    const insert = await pool.query(
      `INSERT INTO feedback_tickets
         (user_id, phone, message, status, category, subject, source, transaction_ref, created_at)
       VALUES
         ($1, $2, $3, 'open', $4, $5, 'payment_failure_auto', $6, (NOW() AT TIME ZONE 'Asia/Kolkata'))
       RETURNING id`,
      [
        row.user_id || null,
        row.phone || null,
        message,
        "payment",
        subject,
        gatewayOrderId,
      ]
    );

    const ticketId = insert.rows[0]?.id || null;
    const ticketRef = ticketId ? String(ticketId).slice(0, 8).toUpperCase() : null;

    return res.json({
      ok: true,
      ticketRef,
      message:
        "Your complaint has been registered. Our team will review it and contact you within 24 hours.",
    });
  } catch (e) {
    console.error("Auto-complaint error:", e);
    return res.status(500).json({
      ok: false,
      message:
        "We could not register your complaint right now. Please try the regular complaint form or call us.",
    });
  }
});

export default router;
