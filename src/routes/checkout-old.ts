// routes/checkout.ts
import express from "express";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";
import https from "https";
import { sendContestRegistrationMessageOnce } from "../services/contestConfirmation";

const router = express.Router();



type BookLanguageMap = Record<string, string[]>;

async function fetchAvailableBookLanguages(): Promise<BookLanguageMap> {
  const q = await pool.query(
    `
    SELECT
      TRIM(book_title) AS book_title,
      TRIM(book_language) AS book_language
    FROM shipment_book_stock
    WHERE COALESCE(stock_qty, 0) > 0
      AND COALESCE(TRIM(book_title), '') <> ''
      AND COALESCE(TRIM(book_language), '') <> ''
    ORDER BY book_title ASC, book_language ASC
    `
  );

  const map: BookLanguageMap = {};

  for (const row of q.rows) {
    const bookTitle = String(row.book_title || "").trim();
    const bookLanguage = String(row.book_language || "").trim();

    if (!bookTitle || !bookLanguage) continue;
    if (!map[bookTitle]) map[bookTitle] = [];
    if (!map[bookTitle].includes(bookLanguage)) {
      map[bookTitle].push(bookLanguage);
    }
  }

  return map;
}


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
        c.price,
        c.default_book_title
     FROM cart_items ci
     JOIN contests c ON c.id = ci.contest_id
     WHERE ci.user_id=$1
     ORDER BY ci.created_at ASC`,
    [userId]
  );

  if (!cartQ.rows.length) {
    return res.redirect("/cart-review");
  }

  const availableBookLanguages = await fetchAvailableBookLanguages();
const ssrLanguages = availableBookLanguages["Science of Self Realization"] || [];

  const expandedRows: any[] = [];
  for (const row of cartQ.rows) {
    const qty = Number(row.quantity || 0);
    const fixedBook = String(row.default_book_title || "").trim();
    const allowedLanguages = availableBookLanguages[fixedBook] || [];

    for (let i = 0; i < qty; i++) {
      expandedRows.push({
        cart_item_id: row.cart_item_id,
        contest_id: row.contest_id,
        age_category: row.age_category,
        contest_title: row.contest_title,
        amount: Number(row.price || 0),
        default_book_title: fixedBook,
        saved_book_language: "",
        available_languages: allowedLanguages,
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
    shipment: null,
    deliveryMode: "deliver",
    error: null,
    ssrCount,
    ssrSelectedLanguages: [],
    ssrLanguages: ssrLanguages,
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
        c.price,
        c.default_book_title
     FROM cart_items ci
     JOIN contests c ON c.id = ci.contest_id
     WHERE ci.user_id=$1
     ORDER BY ci.created_at ASC`,
    [userId]
  );


  if (!cartQ.rows.length) {
    return res.status(400).send("Cart is empty");
  }

  const availableBookLanguages = await fetchAvailableBookLanguages();


const expandedRows: any[] = [];
const ssrLanguages = availableBookLanguages["Science of Self Realization"] || [];
for (const row of cartQ.rows) {
  const qty = Number(row.quantity || 0);
  const fixedBook = String(row.default_book_title || "").trim();
  const allowedLanguages = availableBookLanguages[fixedBook] || [];

  for (let i = 0; i < qty; i++) {
    expandedRows.push({
      cart_item_id: row.cart_item_id,
      contest_id: row.contest_id,
      age_category: row.age_category,
      contest_title: row.contest_title,
      amount: Number(row.price || 0),
      default_book_title: fixedBook,
      available_languages: allowedLanguages,
    });
  }
}

  const ssrCount = calcSsrCountFromRows(cartQ.rows || []);

  const userQ = await pool.query(
    `SELECT id, name, email, phone, phone_locked, address, city, state, pincode
     FROM users
     WHERE id=$1`,
    [userId]
  );
  const user = userQ.rows[0] || null;

  const deliveryMode = String(req.body.deliveryMode || "").trim();
  const isDonate = deliveryMode === "donate";
  const isTemplePickup = deliveryMode === "temple_pickup";
  const isDeliver = deliveryMode === "deliver";

  const bookLangArr = ([] as any[]).concat(req.body.bookLanguage || []);
  const ageCategoryArr = ([] as any[]).concat(req.body.ageCategory || []);
  const ssrLangArr = ([] as any[]).concat(req.body.ssrLanguage || []);

  const hydratedOrders = expandedRows.map((row, i) => ({
    ...row,
    age_category: String(
      (isDonate ? row.age_category : ageCategoryArr[i]) || row.age_category || ""
    ).trim(),
    saved_book_language: String(isDonate ? "" : (bookLangArr[i] || "")).trim(),
  }));

  const savedSsrLanguages = ssrLangArr.map((x: any) => String(x || "").trim());

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
    shipment: null,
    deliveryMode: String(req.body.deliveryMode || "deliver"),
    error: msg,
    ssrCount,
    ssrSelectedLanguages: savedSsrLanguages,
    ssrLanguages: ssrLanguages,
  });
};

  if (!["deliver", "donate", "temple_pickup"].includes(deliveryMode)) {
    return renderError("Please choose Home Delivery, Donation, or Collect directly from temple.");
  }

  const phoneStr = String(req.body.phone || user?.phone || "").trim();
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
  if (fullName.length < 2) {
    return renderError("Full name is required.");
  }

  if (!isDonate) {
    if (ageCategoryArr.length !== expandedRows.length || bookLangArr.length !== expandedRows.length) {
      return renderError("Please select age category and language for each contest row.");
    }

    for (let i = 0; i < expandedRows.length; i++) {
      const age = String(ageCategoryArr[i] || "").trim();
      const lang = String(bookLangArr[i] || "").trim();
      const fixedBook = String(expandedRows[i].default_book_title || "").trim();

      if (!["0-25", "above-25"].includes(age)) {
        return renderError("Please choose valid age category for every contest row.");
      }
      if (!fixedBook) {
        return renderError("One or more contests do not have default book configured.");
      }

      if (!lang) {
        return renderError("Please select language for every row.");
      }

    const allowedLanguages = expandedRows[i].available_languages || [];
        if (!allowedLanguages.includes(lang)) {
          return renderError(`Selected language is out of stock for ${fixedBook}. Please choose another available language.`);
        }
        if (!Array.isArray(allowedLanguages) || allowedLanguages.length === 0) {
  return renderError(`Currently no language is available for ${fixedBook}. Please try again later or contact support.`);
}
    }
    }
    else {
        for (let i = 0; i < expandedRows.length; i++) {
        const finalAge = String(expandedRows[i].age_category || "").trim();
        if (!["0-25", "above-25"].includes(finalAge)) {
        return renderError("Please select age category in cart before continuing.");
      }
    }
  }


  if (isDeliver) {
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

  if (ssrLangArr.length !== ssrCount) {
    return renderError("Please select language for all free Science of Self Realization books.");
  }

  for (let i = 0; i < ssrCount; i++) {
    const lang = String(ssrLangArr[i] || "").trim();
    if (!lang) {
      return renderError("Please select language for all free Science of Self Realization books.");
    }
  }
}

  const paymentId = "KNC" + Math.random().toString(36).slice(2, 10).toUpperCase();

  await pool.query("BEGIN");
  try {
    if (!isDonate) {
      for (let i = 0; i < expandedRows.length; i++) {
        await pool.query(
          `UPDATE cart_items
           SET age_category=$1
           WHERE id=$2 AND user_id=$3`,
          [
            String(ageCategoryArr[i] || "").trim(),
            expandedRows[i].cart_item_id,
            userId,
          ]
        );
      }
    }

    const createdOrderIds: string[] = [];

    for (let i = 0; i < expandedRows.length; i++) {
      const row = expandedRows[i];
      const finalAge = String(
        isDonate ? row.age_category : (ageCategoryArr[i] || "")
      ).trim();
      const fixedBook = String(row.default_book_title || "").trim();

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
          finalAge,
          isDonate ? "donation" : "book",
          fullName,
          isDeliver ? fixedBook : null,
        ]
      );

      createdOrderIds.push(ins.rows[0].id);
    }

    if (isDonate) {
      await pool.query(`DELETE FROM cart_items WHERE user_id=$1`, [userId]);
      await pool.query("COMMIT");
      return res.redirect(`/payment/embedded?paymentId=${encodeURIComponent(paymentId)}`);
    }

    const address = String(req.body.address || "").trim();
    const city = String(req.body.city || "").trim();
    const state = String(req.body.state || "").trim();
    const pincode = String(req.body.pincode || "").trim();

    const shipmentInsert =
      isTemplePickup
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
      const fixedBook = String(expandedRows[i].default_book_title || "").trim();
      const bookLanguage = String(bookLangArr[i] || "").trim();

      await pool.query(
        `INSERT INTO shipment_items (shipment_id, order_id, book_title, book_language)
         VALUES ($1,$2,$3,$4)`,
        [shipmentId, orderId, fixedBook, bookLanguage]
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

    if (isDeliver) {
      await pool.query(
        `UPDATE users
         SET address=$1, city=$2, state=$3, pincode=$4
         WHERE id=$5`,
        [address, city, state, pincode, userId]
      );
    }

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

  try {
    if (paid) {
      const userRow = userQ.rows[0] || null;
      const paymentSessionId =
        ordersQ.rows[0]?.payment_session_id
          ? String(ordersQ.rows[0].payment_session_id)
          : null;

      await sendContestRegistrationMessageOnce({
        paymentId,
        paymentSessionId,
        userId: String(userId),
        phone: String(userRow?.phone || ""),
        userName: String(userRow?.name || "Participant"),
        contestTitles: ordersQ.rows
          .map((o: any) => String(o.contest_title || "").trim())
          .filter(Boolean),
      });
    }
  } catch (e) {
    console.error("contest registration confirmation send error:", e);
  }

  return res.render("payment-success", {
    paid,
    paymentId,
    orders: ordersQ.rows,
    shipment: shipQ.rows[0] || null,
    shipmentItems: shipmentItemsQ.rows,
    bonusItems: bonusItemsQ.rows,
    user: userQ.rows[0] || null,
    payment_session_id: ordersQ.rows[0].payment_session_id,
  });
});

export default router;