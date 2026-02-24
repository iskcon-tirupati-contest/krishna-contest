// routes/checkout.ts
import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();
const BOOKS = ["Bhagavad Gita", "Krishna Book", "Ramayana", "Mahabharata"];
const LANGUAGES = ["English", "Tamil", "Telugu", "Kannada", "Hindi"];

// --------------------
// SINGLE checkout (keep your existing flow)
// --------------------
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

  return { order: orderQ.rows[0], user: userQ.rows[0] };
}

router.get("/checkout", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const orderId = String(req.query.orderId || "");
  if (!orderId) return res.status(400).send("Missing orderId");

  const { order, user } = await loadCheckoutData(orderId, userId);
  if (!order) return res.status(404).send("Order not found");

  if (order.payment_status !== "paid") return res.redirect(`/payment?orderId=${orderId}`);

  return res.render("checkout", { order, user, books: BOOKS, error: null });
});

// --------------------
// BULK checkout (FIXED)
// --------------------
router.get("/checkout/bulk", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const paymentId = String(req.query.paymentId || "");
  if (!paymentId) return res.status(400).send("Missing paymentId");

  const ordersQ = await pool.query(
    `SELECT o.*, c.title AS contest_title
     FROM orders o
     JOIN contests c ON c.id=o.contest_id
     WHERE o.user_id=$1 AND o.payment_id=$2
     ORDER BY o.created_at ASC`,
    [userId, paymentId]
  );
  if (ordersQ.rows.length === 0) return res.status(404).send("Orders not found");

  const anyUnpaid = ordersQ.rows.some((o: any) => o.payment_status !== "paid");
  if (anyUnpaid) return res.redirect(`/payment?paymentId=${encodeURIComponent(paymentId)}`);

  const userQ = await pool.query(
    `SELECT name, email, phone, phone_locked, address, city, state, pincode
     FROM users WHERE id=$1`,
    [userId]
  );

  return res.render("checkout-bulk", {
    paymentId,
    orders: ordersQ.rows,
    user: userQ.rows[0],
    books: BOOKS,
    languages: LANGUAGES, // ✅ FIX
    error: null,
  });
});

// ✅ KEEP ONLY THIS POST (delete your older duplicate POST /checkout/bulk)
router.post("/checkout/bulk", authMiddleware, async (req: any, res) => {
  const userId = req.userId;
  const paymentId = String(req.body.paymentId || "");
  if (!paymentId) return res.status(400).send("Missing paymentId");

  const ordersQ = await pool.query(
    `SELECT o.*, c.title AS contest_title
     FROM orders o
     JOIN contests c ON c.id=o.contest_id
     WHERE o.user_id=$1 AND o.payment_id=$2
     ORDER BY o.created_at ASC`,
    [userId, paymentId]
  );
  if (ordersQ.rows.length === 0) return res.status(404).send("Orders not found");

  const anyUnpaid = ordersQ.rows.some((o: any) => o.payment_status !== "paid");
  if (anyUnpaid) return res.redirect(`/payment?paymentId=${encodeURIComponent(paymentId)}`);

  const userQ = await pool.query(
    `SELECT name, email, phone, phone_locked, address, city, state, pincode
     FROM users WHERE id=$1`,
    [userId]
  );
  const user = userQ.rows[0];

  const renderError = (msg: string) =>
    res.status(400).render("checkout-bulk", {
      paymentId,
      orders: ordersQ.rows,
      user,
      books: BOOKS,
      languages: LANGUAGES, // ✅ FIX (so page can render even on error)
      error: msg,
    });

  // 1) delivery choice
  const deliveryMode = String(req.body.deliveryMode || "");
  if (!["deliver", "donate"].includes(deliveryMode)) {
    return renderError("Please choose Deliver to Home or Donate.");
  }

  // 2) phone lock logic
  const phoneStr = String(req.body.phone || "").trim();
  if (!/^[6-9][0-9]{9}$/.test(phoneStr)) {
    return renderError("Please enter a valid 10-digit Indian mobile number.");
  }

  const existingPhone = user?.phone ? String(user.phone).trim() : "";
  if (existingPhone && existingPhone !== phoneStr) {
    return renderError("Mobile number cannot be changed. Please use your registered mobile number.");
  }
  if (!existingPhone) {
    const clash = await pool.query(`SELECT id FROM users WHERE phone=$1`, [phoneStr]);
    if (clash.rows.length > 0) return renderError("This mobile number is already registered. Please login with that number.");
    await pool.query(`UPDATE users SET phone=$1, phone_locked=true WHERE id=$2`, [phoneStr, userId]);
  }

  const shipmentName = String(req.body.fullName || user?.name || "").trim();
  if (shipmentName.length < 2) return renderError("Full name is required.");

  // 3) DONATE: mark orders donation + cleanup shipment/shipment_items if any
  if (deliveryMode === "donate") {
    await pool.query(
      `UPDATE orders
       SET book_option='donation', book_title=NULL
       WHERE user_id=$1 AND payment_id=$2 AND payment_status='paid'`,
      [userId, paymentId]
    );

    // cleanup any previous shipment created for this payment group
    const shipQ = await pool.query(`SELECT id FROM shipments WHERE payment_id=$1 LIMIT 1`, [paymentId]);
    if (shipQ.rows.length > 0) {
      const shipmentId = shipQ.rows[0].id;
      await pool.query(`DELETE FROM shipment_items WHERE shipment_id=$1`, [shipmentId]);
      await pool.query(`DELETE FROM shipments WHERE id=$1`, [shipmentId]);
    }

    return res.render("payment-success");
  }

  // 4) DELIVER: validate address + book rows
  const address = String(req.body.address || "").trim();
  const city = String(req.body.city || "").trim();
  const state = String(req.body.state || "").trim();
  const pincode = String(req.body.pincode || "").trim();

  if (!/^[1-9][0-9]{5}$/.test(pincode)) return renderError("Please enter a valid 6-digit Indian pincode.");
  if (!address || !city || !state) return renderError("Please fill complete address (Address, City, State, Pincode).");

  const bookTitleArr = ([] as any[]).concat(req.body.bookTitle || []);
  const bookLangArr = ([] as any[]).concat(req.body.bookLanguage || []);

  if (bookTitleArr.length !== ordersQ.rows.length || bookLangArr.length !== ordersQ.rows.length) {
    return renderError("Please select Book + Language for each contest row.");
  }

  for (let i = 0; i < ordersQ.rows.length; i++) {
    const bt = String(bookTitleArr[i] || "").trim();
    const bl = String(bookLangArr[i] || "").trim();
    if (!bt) return renderError("Please select book for every row.");
    if (!bl) return renderError("Please select language for every row.");
  }

  // 5) Create/Update ONE shipment per payment_id
  const shipQ = await pool.query(`SELECT id FROM shipments WHERE payment_id=$1 LIMIT 1`, [paymentId]);

  let shipmentId: string;

  if (shipQ.rows.length === 0) {
    const created = await pool.query(
      `INSERT INTO shipments (payment_id, address, city, state, pincode, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())
       RETURNING id`,
      [paymentId, address, city, state, pincode]
    );
    shipmentId = created.rows[0].id;
  } else {
    shipmentId = shipQ.rows[0].id;
    await pool.query(
      `UPDATE shipments
       SET address=$1, city=$2, state=$3, pincode=$4, status='pending', updated_at=NOW()
       WHERE id=$5`,
      [address, city, state, pincode, shipmentId]
    );
    await pool.query(`DELETE FROM shipment_items WHERE shipment_id=$1`, [shipmentId]);
  }

  // 6) Save per order + shipment_items
  for (let i = 0; i < ordersQ.rows.length; i++) {
    const orderId = ordersQ.rows[i].id;
    const bookTitle = String(bookTitleArr[i]).trim();
    const bookLanguage = String(bookLangArr[i]).trim();

    await pool.query(
      `UPDATE orders
       SET book_option='book'
       WHERE id=$1 AND user_id=$2 AND payment_status='paid'`,
      [orderId, userId]
    );

    await pool.query(
      `INSERT INTO shipment_items (shipment_id, order_id, book_title, book_language)
       VALUES ($1,$2,$3,$4)`,
      [shipmentId, orderId, bookTitle, bookLanguage]
    );
  }

  await pool.query(
    `UPDATE users SET address=$1, city=$2, state=$3, pincode=$4 WHERE id=$5`,
    [address, city, state, pincode, userId]
  );

  return res.render("payment-success");
});

export default router;