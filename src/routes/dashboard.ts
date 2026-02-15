import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

router.get("/dashboard", authMiddleware, async (req: any, res) => {

  const contests = await pool.query(
    `SELECT * FROM contests WHERE is_active = true`
  );

  const orders = await pool.query(
    `SELECT contest_id FROM orders 
     WHERE user_id = $1 AND payment_status = 'paid'`,
    [req.userId]
  );

  const purchased = orders.rows.map(row => row.contest_id);

  res.render("dashboard", {
    contests: contests.rows,
    purchased,
  });
});

export default router;


