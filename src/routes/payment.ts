import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";
import crypto from "crypto";

const router = express.Router();

function genPaymentId() {
  return "KNC" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

router.get("/payment", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.query.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  const q = await pool.query(
    `SELECT o.*, c.title AS contest_title
     FROM orders o
     JOIN contests c ON c.id=o.contest_id
     WHERE o.id=$1 AND o.user_id=$2`,
    [orderId, userId]
  );
  if (q.rows.length === 0) return res.status(404).send("Order not found");

  const order = q.rows[0];
  if (order.payment_status === "paid") return res.redirect("/dashboard");

  // must have book_option selected before paying
  if (!order.book_option) return res.status(400).send("Please complete checkout first.");

  // if gift book, shipment must exist
  if (order.book_option === "book") {
    const ship = await pool.query(`SELECT id FROM shipments WHERE order_id=$1`, [orderId]);
    if (ship.rows.length === 0) return res.status(400).send("Address missing. Please complete checkout.");
  }

  res.render("payment", { order });
});

router.post("/payment-initiate", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.body.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  const q = await pool.query(
    `SELECT * FROM orders WHERE id=$1 AND user_id=$2`,
    [orderId, userId]
  );
  if (q.rows.length === 0) return res.status(404).send("Order not found");
  const order = q.rows[0];
  if (order.payment_status === "paid") return res.redirect("/dashboard");

  // create payment_id if not exists
  const pid = order.payment_id || genPaymentId();

  await pool.query(
    `UPDATE orders
     SET payment_id=$1, payment_status='pending'
     WHERE id=$2 AND user_id=$3`,
    [pid, orderId, userId]
  );

  // show processing page
  res.render("payment-response", { orderId, paymentId: pid });

  // Once HDFC kit is ready:
  // Here you will redirect/post to HDFC gateway with paymentId, amount, etc.
});

// TEMP simulate (remove later)
router.get("/payment/simulate/success", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.query.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  await pool.query(
    `UPDATE orders
     SET payment_status='paid'
     WHERE id=$1 AND user_id=$2`,
    [orderId, userId]
  );

  res.render("payment-success");
});

router.get("/payment/simulate/failure", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.query.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  await pool.query(
    `UPDATE orders
     SET payment_status='failed'
     WHERE id=$1 AND user_id=$2`,
    [orderId, userId]
  );

  res.render("payment-failure", { orderId });

});

export default router;
