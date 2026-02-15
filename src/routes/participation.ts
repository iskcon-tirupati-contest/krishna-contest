import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

router.post("/participate/:contestId", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const contestId = req.params.contestId;

  // Check if already purchased
  const existing = await pool.query(
    `SELECT * FROM orders 
     WHERE user_id = $1 AND contest_id = $2`,
    [userId, contestId]
  );

  if (existing.rows.length > 0) {
    return res.send("You already registered for this contest.");
  }

  // Create dummy successful order
  await pool.query(
    `INSERT INTO orders (user_id, contest_id, amount, payment_status, book_option)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, contestId, 399, "paid", "book"]
  );

  console.log("WhatsApp confirmation would be sent here");

  res.redirect("/dashboard");
});

export default router;

