import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

const BOOKS = ["Bhagavad Gita", "Krishna Book", "Ramayana", "Mahabharata"];

async function loadCheckoutData(orderId: string, userId: string) {
  const orderQ = await pool.query(
    `SELECT o.*, c.title AS contest_title
     FROM orders o
     JOIN contests c ON c.id=o.contest_id
     WHERE o.id=$1 AND o.user_id=$2`,
    [orderId, userId]
  );

  const userQ = await pool.query(
    `SELECT name, email, phone, phone_locked, address, city, state, pincode
     FROM users WHERE id=$1`,
    [userId]
  );

  return {
    order: orderQ.rows[0],
    user: userQ.rows[0],
  };
}

router.get("/checkout", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.query.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  const { order, user } = await loadCheckoutData(orderId, userId);
  if (!order) return res.status(404).send("Order not found");
  if (order.payment_status === "paid") return res.redirect("/dashboard");

  res.render("checkout", {
    order,
    user,
    books: BOOKS,
    error: null,
  });
});

router.post("/checkout", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const {
    orderId,
    bookOption, // "book" | "donation"
    bookTitle,
    fullName,
    dob,
    phone,
    address,
    city,
    state,
    pincode,
  } = req.body;

  if (!orderId) return res.status(400).send("Missing orderId");

  const { order, user } = await loadCheckoutData(String(orderId), userId);
  if (!order) return res.status(404).send("Order not found");
  if (order.payment_status === "paid") return res.redirect("/dashboard");

  const renderError = (msg: string) =>
    res.status(400).render("checkout", { order, user, books: BOOKS, error: msg });

  if (!bookOption || !["book", "donation"].includes(String(bookOption))) {
    return renderError("Please select Gift Book or Donate Book.");
  }

  const phoneStr = String(phone || "").trim();
  if (!/^[6-9][0-9]{9}$/.test(phoneStr)) {
    return renderError("Please enter a valid 10-digit Indian mobile number.");
  }

  // enforce phone lock rule
  const existingPhone = user?.phone ? String(user.phone).trim() : "";
  if (existingPhone && existingPhone !== phoneStr) {
    return renderError("Mobile number cannot be changed. Please use your registered mobile number.");
  }

  // first time phone capture: ensure unique + lock
  if (!existingPhone) {
    const clash = await pool.query(`SELECT id FROM users WHERE phone=$1`, [phoneStr]);
    if (clash.rows.length > 0) {
      return renderError("This mobile number is already registered. Please login with that number.");
    }
    await pool.query(`UPDATE users SET phone=$1, phone_locked=true WHERE id=$2`, [phoneStr, userId]);
  }

  // Gift Book flow validations
  const isBook = String(bookOption) === "book";
  if (isBook) {
    if (!bookTitle) return renderError("Please select a gift book.");
    if (!fullName || String(fullName).trim().length < 2) return renderError("Full name is required.");

    const pinStr = String(pincode || "").trim();
    if (!/^[1-9][0-9]{5}$/.test(pinStr)) {
      return renderError("Please enter a valid 6-digit Indian pincode.");
    }
    if (!address || !city || !state) {
      return renderError("Please fill complete address (Address, City, State, Pincode).");
    }
  }

  // Save order fields (you already have columns)
  await pool.query(
    `UPDATE orders
     SET book_option=$1, book_title=$2, full_name=$3, dob=$4
     WHERE id=$5 AND user_id=$6`,
    [
      String(bookOption),
      isBook ? String(bookTitle || "").trim() : null,
      isBook ? String(fullName || "").trim() : null,
      isBook && dob ? dob : null,
      orderId,
      userId,
    ]
  );

  // Shipments snapshot only for book option
  if (isBook) {
    const ship = await pool.query(`SELECT id FROM shipments WHERE order_id=$1`, [orderId]);
    if (ship.rows.length === 0) {
      await pool.query(
        `INSERT INTO shipments (order_id, address, city, state, pincode, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
        [
          orderId,
          String(address).trim(),
          String(city).trim(),
          String(state).trim(),
          String(pincode).trim(),
        ]
      );
    } else {
      await pool.query(
        `UPDATE shipments
         SET address=$1, city=$2, state=$3, pincode=$4, status='pending', updated_at=NOW()
         WHERE order_id=$5`,
        [
          String(address).trim(),
          String(city).trim(),
          String(state).trim(),
          String(pincode).trim(),
          orderId,
        ]
      );
    }

    // Save as user's default address for next time autofill
    await pool.query(
      `UPDATE users
       SET address=$1, city=$2, state=$3, pincode=$4
       WHERE id=$5`,
      [
        String(address).trim(),
        String(city).trim(),
        String(state).trim(),
        String(pincode).trim(),
        userId,
      ]
    );
  }

  return res.redirect(`/payment?orderId=${orderId}`);
});

export default router;
