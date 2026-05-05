// src/routes/complaint.ts
import express from "express";
import { pool } from "../config/db";

const router = express.Router();
const norm = (v: any) => String(v ?? "").trim();

// ── Public complaint form (no auth required — IVR users may not be logged in)
router.get("/complaint", async (req, res) => {
  const category = norm(req.query.category || "general");
  return res.render("complaint", {
    category,
    error: null,
    success: null,
  });
});

router.post("/complaint", async (req: any, res) => {
  const name        = norm(req.body.name);
  const phone       = String(req.body.phone || "").replace(/\D/g, "").slice(-10);
  const category    = norm(req.body.category || "general");
  const subCategory = norm(req.body.sub_category || "");
  const txRef       = norm(req.body.transaction_ref || "");
  const message     = norm(req.body.message);

  // Basic validation
  if (!name || name.length < 2) {
    return res.render("complaint", { category, error: "Please enter your name.", success: null });
  }
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return res.render("complaint", { category, error: "Please enter a valid 10-digit mobile number.", success: null });
  }
  if (!message || message.length < 10) {
    return res.render("complaint", { category, error: "Please describe your issue (min 10 characters).", success: null });
  }

  try {
    // Try to find user by phone — link if exists, else store as anonymous
    const userQ = await pool.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [phone]
    );
    const userId = userQ.rows[0]?.id || null;

    await pool.query(
      `INSERT INTO feedback_tickets
         (user_id, phone, message, status, category, subject, source, transaction_ref, created_at)
       VALUES
         ($1, $2, $3, 'open', $4, $5, 'ivr_complaint_form', $6, (NOW() AT TIME ZONE 'Asia/Kolkata'))`,
      [
        userId,
        phone,
        message,
        category,
        subCategory || null,
        txRef || null,
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Complaint submit error:", err);
    return res.render("complaint", {
      category,
      error: "Something went wrong. Please try again or call us.",
      success: null,
    });
  }
});

export default router;