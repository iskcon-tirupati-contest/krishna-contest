// routes/participation.ts
import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

router.post("/participate/:contestId", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const contestId = req.params.contestId;

  // latest order for this contest (for this user)
  const existing = await pool.query(
    `SELECT id, payment_status
     FROM orders
     WHERE user_id=$1 AND contest_id=$2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, contestId]
  );

  if (existing.rows.length > 0) {
    const o = existing.rows[0];

    // ✅ if pending, resume payment directly (avoid duplicates)
    if (o.payment_status === "pending") {
      return res.redirect(`/payment?orderId=${o.id}`);
    }

    // ✅ if paid/failed/etc: allow new participation by creating a new pending order below
  }

  const c = await pool.query(`SELECT id, price FROM contests WHERE id=$1`, [contestId]);
  if (c.rows.length === 0) return res.status(404).send("Contest not found");

  const amount = Number(c.rows[0].price || 399);

  const order = await pool.query(
    `INSERT INTO orders (user_id, contest_id, amount, payment_status, created_at)
     VALUES ($1,$2,$3,'pending',(NOW() AT TIME ZONE 'Asia/Kolkata'))
     RETURNING id`,
    [userId, contestId, amount]
  );

  return res.redirect(`/payment?orderId=${order.rows[0].id}`);
});

export default router;