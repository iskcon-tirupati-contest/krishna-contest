// routes/checkout.ts
import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";
import https from "https";

const router = express.Router();

const BOOKS = [
  "Bhagavad Gita",
  "Krishna Book",
  "Ramayana",
  "Bhagavatam"
];

const LANGUAGES = ["English", "Tamil", "Telugu", "Kannada", "Hindi"];

const RZP_KEY_ID = process.env.RZP_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RZP_KEY_SECRET || "";

function calcSsrCountFromRows(rows: Array<{ quantity?: number }>) {
  const totalQty = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  return Math.floor(totalQty / 4);
}



function rzpRequest(method: "GET" | "POST", path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");

    const req = https.request(
      {
        hostname: "api.razorpay.com",
        path,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const status = res.statusCode || 0;
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {}
          if (status >= 200 && status < 300) return resolve(json);
          return reject(new Error(`RZP ${method} ${path} failed: ${status} ${data?.slice(0, 200)}`));
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function renderReview(res: any, data: any) {
  return res.render("checkout-review", data);
}



router.get("/checkout/review", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const cartQ = await pool.query(
    `SELECT
        ci.id AS cart_item_id,
        ci.contest_id,
        ci.age_category,
        ci.quantity,
        c.title AS contest_title,
        c.price
     FROM cart_items ci
     JOIN contests c ON c.id = ci.contest_id
     WHERE ci.user_id=$1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  if (!cartQ.rows.length) {
    return res.redirect("/cart-review");
  }

  const expandedRows: any[] = [];
  for (const row of cartQ.rows) {
    const qty = Number(row.quantity || 0);
    for (let i = 0; i < qty; i++) {
      expandedRows.push({
        cart_item_id: row.cart_item_id,
        contest_id: row.contest_id,
        age_category: row.age_category,
        contest_title: row.contest_title,
        amount: Number(row.price || 0),
        saved_book_title: "",
        saved_book_language: "",
      });
    }
  }

  const userQ = await pool.query(
    `SELECT id, name, email, phone, phone_locked, address, city, state, pincode
     FROM users
     WHERE id=$1
     LIMIT 1`,
    [userId]
  );

  const ssrCount = calcSsrCountFromRows(cartQ.rows || []);

  return renderReview(res, {
    paymentId: "",
    orders: expandedRows,
    user: userQ.rows[0] || null,
    books: BOOKS,
    languages: LANGUAGES,
    shipment: null,
    deliveryMode: "deliver",
    error: null,
    ssrCount,
    ssrSelectedLanguages: [],
  });
});


router.post("/checkout/review", authMiddleware, async (req: any, res) => {
  const userId = req.userId;

  const cartQ = await pool.query(
    `SELECT
        ci.id AS cart_item_id,
        ci.contest_id,
        ci.age_category,
        ci.quantity,
        c.title AS contest_title,
        c.price
     FROM cart_items ci
     JOIN contests c ON c.id = ci.contest_id
     WHERE ci.user_id=$1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  if (!cartQ.rows.length) {
    return res.status(400).send("Cart is empty");
  }

  const expandedRows: any[] = [];
  for (const row of cartQ.rows) {
    const qty = Number(row.quantity || 0);
    for (let i = 0; i < qty; i++) {
      expandedRows.push({
        cart_item_id: row.cart_item_id,
        contest_id: row.contest_id,
        age_category: row.age_category,
        contest_title: row.contest_title,
        amount: Number(row.price || 0),
      });
    }
  }

 const ssrCount = calcSsrCountFromRows(cartQ.rows || []);

  const userQ = await pool.query(
    `SELECT name, email, phone, phone_locked, address, city, state, pincode
     FROM users
     WHERE id=$1`,
    [userId]
  );
  const user = userQ.rows[0] || null;

  const renderError = async (msg: string) => {
     return renderReview(res, {
      paymentId: "",
      orders: hydratedOrders,
      user: {
        ...(user || {}),
        name: req.body.fullName || user?.name || "",
        phone: req.body.phone || user?.phone || "",
        address: req.body.address || user?.address || "",
        city: req.body.city || user?.city || "",
        state: req.body.state || user?.state || "",
        pincode: req.body.pincode || user?.pincode || "",
      },
      books: BOOKS,
      languages: LANGUAGES,
      shipment: null,
      deliveryMode: String(req.body.deliveryMode || "deliver"),
      error: msg,
      ssrCount,
      ssrSelectedLanguages: savedSsrLanguages,
    });
  };

const deliveryMode = String(req.body.deliveryMode || "").trim();
if (!["deliver", "donate", "temple_pickup"].includes(deliveryMode)) {
  return renderError("Please choose Home Delivery, Donation, or Collect directly from temple.");
}

  const phoneStr = String(req.body.phone || "").trim();
  if (!/^[6-9]\d{9}$/.test(phoneStr)) {
    return renderError("Please enter a valid 10-digit mobile number.");
  }

  const existingPhone = user?.phone ? String(user.phone).trim() : "";
if (!existingPhone) {
  const clash = await pool.query(`SELECT id FROM users WHERE phone=$1`, [phoneStr]);
  if (clash.rows.length > 0) {
    return renderError("This mobile number is already registered. Please login with that number.");
  }
}

  const fullName = String(req.body.fullName || user?.name || "").trim();
  if (fullName.length < 2) return renderError("Full name is required.");

  const bookTitleArr = ([] as any[]).concat(req.body.bookTitle || []);
  const bookLangArr = ([] as any[]).concat(req.body.bookLanguage || []);
  const ssrLangArr = ([] as any[]).concat(req.body.ssrLanguage || []);

  const hydratedOrders = expandedRows.map((row, i) => ({
    ...row,
    saved_book_title: String(bookTitleArr[i] || "").trim(),
    saved_book_language: String(bookLangArr[i] || "").trim(),
  }));

  const savedSsrLanguages = ssrLangArr.map((x: any) => String(x || "").trim());

  if (deliveryMode === "deliver") {
    const address = String(req.body.address || "").trim();
    const city = String(req.body.city || "").trim();
    const state = String(req.body.state || "").trim();
    const pincode = String(req.body.pincode || "").trim();

    if (!/^[1-9][0-9]{5}$/.test(pincode)) {
      return renderError("Please enter a valid 6-digit Indian pincode.");
    }
    if (!address || !city || !state) {
      return renderError("Please fill complete address (Address, City, State, Pincode).");
    }

    if (bookTitleArr.length !== expandedRows.length || bookLangArr.length !== expandedRows.length) {
      return renderError("Please select Book + Language for each contest row.");
    }

    if (ssrLangArr.length !== ssrCount) {
      return renderError("Please select language for all free Science of Self Realization books.");
    }

    for (let i = 0; i < ssrCount; i++) {
      const lang = String(ssrLangArr[i] || "").trim();
      if (!lang) {
        return renderError("Please select language for all free Science of Self Realization books.");
      }
    }

    for (let i = 0; i < expandedRows.length; i++) {
      const bt = String(bookTitleArr[i] || "").trim();
      const bl = String(bookLangArr[i] || "").trim();
      if (!bt) return renderError("Please select book for every row.");
      if (!bl) return renderError("Please select language for every row.");
    }
  }

  const paymentId = "KNC" + Math.random().toString(36).slice(2, 10).toUpperCase();

  await pool.query("BEGIN");
  try {
   /* if (!existingPhone) {
      await pool.query(`UPDATE users SET phone=$1, phone_locked=true WHERE id=$2`, [phoneStr, userId]);
    }

    await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [fullName, userId]);
*/
    const createdOrderIds: string[] = [];

    for (let i = 0; i < expandedRows.length; i++) {
      const row = expandedRows[i];

      const ins = await pool.query(
        `INSERT INTO orders
         (user_id, contest_id, amount, payment_status, payment_id, age_category, created_at, book_option, full_name, book_title)
         VALUES ($1,$2,$3,'pending',$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata'),$6,$7,$8)
         RETURNING id`,
        [
          userId,
          row.contest_id,
          Number(row.amount || 0),
          paymentId,
          row.age_category,
          deliveryMode === "donate" ? "donation" : "book",
          fullName,
          deliveryMode === "deliver" ? String(bookTitleArr[i] || "").trim() : null,
        ]
      );

      createdOrderIds.push(ins.rows[0].id);
    }

   /* if (deliveryMode === "donate") {
      await pool.query(`DELETE FROM cart_items WHERE user_id=$1`, [userId]);
      await pool.query("COMMIT");
      return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
    }

    const address = String(req.body.address || "").trim();
    const city = String(req.body.city || "").trim();
    const state = String(req.body.state || "").trim();
    const pincode = String(req.body.pincode || "").trim();

    const createdShipment = await pool.query(
      `INSERT INTO shipments (payment_id, address, city, state, pincode, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())
       RETURNING id`,
      [paymentId, address, city, state, pincode]
    );

    const shipmentId = createdShipment.rows[0].id;
*/

      if (deliveryMode === "donate") {
          await pool.query(`DELETE FROM cart_items WHERE user_id=$1`, [userId]);
          await pool.query("COMMIT");
          return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
        }

        const address = String(req.body.address || "").trim();
        const city = String(req.body.city || "").trim();
        const state = String(req.body.state || "").trim();
        const pincode = String(req.body.pincode || "").trim();

        const shipmentInsert =
          deliveryMode === "temple_pickup"
            ? await pool.query(
                `INSERT INTO shipments
                 (payment_id, recipient_name, recipient_phone, delivery_mode, status, updated_at)
                 VALUES ($1,$2,$3,'temple_pickup','pending',NOW())
                 RETURNING id`,
                [paymentId, fullName, phoneStr]
              )
            : await pool.query(
                `INSERT INTO shipments
                 (payment_id, recipient_name, recipient_phone, address, city, state, pincode, delivery_mode, status, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'home_delivery','pending',NOW())
                 RETURNING id`,
                [paymentId, fullName, phoneStr, address, city, state, pincode]
              );

    const shipmentId = shipmentInsert.rows[0].id;

    for (let i = 0; i < createdOrderIds.length; i++) {
      const orderId = createdOrderIds[i];
      const bookTitle = String(bookTitleArr[i] || "").trim();
      const bookLanguage = String(bookLangArr[i] || "").trim();

      await pool.query(
        `INSERT INTO shipment_items (shipment_id, order_id, book_title, book_language)
         VALUES ($1,$2,$3,$4)`,
        [shipmentId, orderId, bookTitle, bookLanguage]
      );
    }

     for (let i = 0; i < ssrCount; i++) {
      const ssrLanguage = String(ssrLangArr[i] || "").trim();

      await pool.query(
        `INSERT INTO shipment_bonus_items (shipment_id, book_title, book_language, quantity)
         VALUES ($1,$2,$3,1)`,
        [shipmentId, "Science of Self Realization", ssrLanguage]
      );
    }

    await pool.query(
      `UPDATE users
       SET address=$1, city=$2, state=$3, pincode=$4
       WHERE id=$5`,
      [address, city, state, pincode, userId]
    );

    await pool.query(`DELETE FROM cart_items WHERE user_id=$1`, [userId]);

    await pool.query("COMMIT");
    return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("checkout/review save error:", e);
    return res.status(500).send("Failed to save checkout details");
  }
});

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

  const paid = ordersQ.rows.every((o: any) => String(o.payment_status || "") === "paid");

  const shipQ = await pool.query(
    `SELECT *
     FROM shipments
     WHERE payment_id=$1
     LIMIT 1`,
    [paymentId]
  );

  const shipmentItemsQ = await pool.query(
    `SELECT si.book_title, si.book_language, o.id AS order_id, c.title AS contest_title
     FROM shipment_items si
     JOIN orders o ON o.id = si.order_id
     JOIN contests c ON c.id = o.contest_id
     JOIN shipments sh ON sh.id = si.shipment_id
     WHERE sh.payment_id=$1
     ORDER BY c.title ASC`,
    [paymentId]
  );

  const bonusItemsQ = await pool.query(
    `SELECT book_title, book_language, quantity
     FROM shipment_bonus_items sbi
     JOIN shipments sh ON sh.id = sbi.shipment_id
     WHERE sh.payment_id=$1
     ORDER BY sbi.created_at ASC`,
    [paymentId]
  );

  const userQ = await pool.query(
    `SELECT name, phone
     FROM users
     WHERE id=$1
     LIMIT 1`,
    [userId]
  );

  return res.render("payment-success", {
    paid,
    paymentId,
    orders: ordersQ.rows,
    shipment: shipQ.rows[0] || null,
    shipmentItems: shipmentItemsQ.rows,
    bonusItems: bonusItemsQ.rows,
    user: userQ.rows[0] || null,
    payment_session_id:ordersQ.rows[0].payment_session_id,
  });
});

export default router;