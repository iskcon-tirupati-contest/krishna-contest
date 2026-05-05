// src/routes/setPassword.ts
//
// Dedicated set-password flow for NEW users coming from direct registration.
// They have a valid auth cookie (set by directRegistration.ts) but no password_hash yet.
//
// GET  /set-password  → render set-password.ejs
// POST /set-password  → hash and save password, return JSON {ok:true}
//
// app.ts wiring (one line):
//   import setPassword from "./routes/setPassword";
//   app.use("/", setPassword);

import express from "express";
import bcrypt from "bcrypt";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

const SALT_ROUNDS = 12;

// ── GET /set-password ─────────────────────────────────────────────────────────
// Auth-gated: user must have cookie set (directRegistration.ts does this).
// If user already has a password, redirect to dashboard — nothing to do here.
router.get("/set-password", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const userQ = await pool.query(
    `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!userQ.rows.length) {
    return res.redirect("/login");
  }

  // Already has a password — redirect away
  if (userQ.rows[0].password_hash) {
    return res.redirect("/dashboard");
  }

  return res.render("set-password");
});

// ── POST /set-password ────────────────────────────────────────────────────────
// Uses the auth cookie to identify user — no phone/OTP needed.
router.post("/set-password", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const newPassword     = String(req.body.newPassword     || "").trim();
  const confirmPassword = String(req.body.confirmPassword || "").trim();

  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ ok: false, message: "Passwords do not match." });
  }

  // Confirm user exists and doesn't already have a password
  // (guard against double-submit or replay)
  const userQ = await pool.query(
    `SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  if (!userQ.rows.length) {
    return res.status(404).json({ ok: false, message: "User not found." });
  }

  // If password is already set, just return ok — idempotent
  if (userQ.rows[0].password_hash) {
    return res.status(200).json({ ok: true, message: "Password already set." });
  }

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await pool.query(
    `UPDATE users SET password_hash = $1 WHERE id = $2`,
    [hash, userId]
  );

  return res.status(200).json({ ok: true });
});

export default router;
