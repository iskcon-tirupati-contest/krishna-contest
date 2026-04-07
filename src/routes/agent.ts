import express, { Response } from "express";
import { body, validationResult } from "express-validator";
import { pool } from "../config/db";
import { authMiddleware } from "../middleware/auth";
import { agentMiddleware } from "../middleware/agent";
import { hashPassword } from "../utils/hash";
import { sendContestRegistrationMessageOnce, sendOfflineRegistrationMessageOnce } from "../services/contestConfirmation";

const router = express.Router();

const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(String(v || "").trim());
const normPhone = (v: string) => String(v || "").replace(/\D/g, "").slice(-10);
const normName = (v: string) => String(v || "").trim().replace(/\s+/g, " ");
const norm = (v: any) => String(v ?? "").trim();


function agentStatusUi(status: any) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "draft") return "pending";
  if (s === "checkout_pending") return "payment pending";
  return s || "-";
}

function deriveAgentCustomerPassword(name: any) {
  const firstWord = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(" ")[0]
    .replace(/[^a-z0-9]/g, "");

  if (!firstWord) return "";
  return `${firstWord}123`;
}

type BookLanguageMap = Record<string, string[]>;


async function fetchAllBookTitles(): Promise<string[]> {
  const q = await pool.query(
    `
    SELECT DISTINCT TRIM(book_title) AS book_title
    FROM shipment_book_stock
    WHERE COALESCE(stock_qty, 0) > 0
      AND COALESCE(TRIM(book_title), '') <> ''
    ORDER BY book_title ASC
    `
  );
  return q.rows.map((r: any) => String(r.book_title || "").trim()).filter(Boolean);
}

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
    if (!map[bookTitle].includes(bookLanguage)) map[bookTitle].push(bookLanguage);
  }
  return map;
}

function calcSsrCount(totalQty: number) {
  return Math.floor(totalQty / 4);
}

function genAgentPaymentId() {
  return "AGT" + Math.random().toString(36).slice(2, 10).toUpperCase();
}


async function fetchSelectableBookTitles(): Promise<string[]> {
  const q = await pool.query(
    `
    SELECT DISTINCT TRIM(book_title) AS book_title
    FROM shipment_book_stock
    WHERE COALESCE(stock_qty, 0) > 0
      AND COALESCE(TRIM(book_title), '') <> ''
      AND TRIM(book_title) <> 'Science of Self Realization'
    ORDER BY book_title ASC
    `
  );

  return q.rows
    .map((r: any) => String(r.book_title || "").trim())
    .filter(Boolean);
}

async function getOrCreateDraftBooking(agentUserId: string, customerUserId: string) {
  const q = await pool.query(
    `
    SELECT *
    FROM agent_bookings
    WHERE agent_user_id=$1
      AND customer_user_id=$2
      AND status='draft'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [agentUserId, customerUserId]
  );

  if (q.rows.length) return q.rows[0];

  const ins = await pool.query(
    `
    INSERT INTO agent_bookings (agent_user_id, customer_user_id, status)
    VALUES ($1,$2,'draft')
    RETURNING *
    `,
    [agentUserId, customerUserId]
  );

  return ins.rows[0];
}

async function loadBookingForAgent(bookingId: string, agentUserId: string) {
  const bq = await pool.query(
    `
    SELECT
      ab.*,
      cu.name AS customer_name,
      cu.phone AS customer_phone,
      au.name AS agent_name
    FROM agent_bookings ab
    JOIN users cu ON cu.id = ab.customer_user_id
    JOIN users au ON au.id = ab.agent_user_id
    WHERE ab.id=$1 AND ab.agent_user_id=$2
    LIMIT 1
    `,
    [bookingId, agentUserId]
  );
  return bq.rows[0] || null;
}

async function loadBookingLines(bookingId: string) {
  const q = await pool.query(
    `
    SELECT
      abl.*,
      c.title AS contest_title,
      c.description,
      c.price,
      c.default_book_title
    FROM agent_booking_lines abl
    JOIN contests c ON c.id = abl.contest_id
    WHERE abl.agent_booking_id=$1
      AND abl.line_status <> 'cancelled'
    ORDER BY abl.created_at ASC
    `,
    [bookingId]
  );
  return q.rows;
}

async function loadContestQtyMap(bookingId: string) {
  const q = await pool.query(
    `
    SELECT contest_id, COUNT(*)::int AS qty
    FROM agent_booking_lines
    WHERE agent_booking_id=$1
      AND line_status <> 'cancelled'
    GROUP BY contest_id
    `,
    [bookingId]
  );

  const map: Record<string, number> = {};
  for (const row of q.rows) map[String(row.contest_id)] = Number(row.qty || 0);
  return map;
}

async function recalcBookingTotals(bookingId: string) {
  const q = await pool.query(
    `
    SELECT COALESCE(SUM(unit_amount),0)::numeric AS total_amount, COUNT(*)::int AS qty
    FROM agent_booking_lines
    WHERE agent_booking_id=$1
      AND line_status <> 'cancelled'
    `,
    [bookingId]
  );

  const totalAmount = Number(q.rows[0]?.total_amount || 0);
  const qty = Number(q.rows[0]?.qty || 0);
  const bonusBookCount = calcSsrCount(qty);

  await pool.query(
    `
    UPDATE agent_bookings
    SET total_amount=$2,
        bonus_book_count=$3,
        updated_at=NOW()
    WHERE id=$1
    `,
    [bookingId, totalAmount, bonusBookCount]
  );

  return { totalAmount, qty, bonusBookCount };
}

// ==============================
// DASHBOARD
// ==============================

router.get("/agent", authMiddleware, agentMiddleware, async (_req: any, res: Response) => {
  return res.redirect("/agent-maintenance");
});

router.get("/agent-maintenance", authMiddleware, agentMiddleware, (_req: any, res: Response) => {
  return res.render("agent/maintainence");
});


router.get("/agent-login-working", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 10;

  const meQ = await pool.query(
    `SELECT id, name, phone FROM users WHERE id=$1 LIMIT 1`,
    [req.userId]
  );

  const todayQ = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (
        WHERE ab.status='paid' AND DATE(ab.created_at)=CURRENT_DATE
      )::int AS bookings_today,

      COALESCE(SUM(
        CASE
          WHEN ab.status='paid' AND DATE(ab.created_at)=CURRENT_DATE THEN ab.total_amount
          ELSE 0
        END
      ),0)::int AS revenue_today,

      COALESCE(SUM(
        CASE
          WHEN ab.status='paid'
           AND DATE(ab.created_at)=CURRENT_DATE
           AND COALESCE(ab.payment_method,'')='cash'
          THEN ab.total_amount
          ELSE 0
        END
      ),0)::int AS cash_today,

      COALESCE(SUM(
        CASE
          WHEN ab.status='paid'
           AND DATE(ab.created_at)=CURRENT_DATE
           AND COALESCE(ab.payment_method,'') IN ('phonepe','upi')
          THEN ab.total_amount
          ELSE 0
        END
      ),0)::int AS upi_today
    FROM agent_bookings ab
    WHERE ab.agent_user_id=$1
    `,
    [req.userId]
  );

  const totalQ = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE ab.status='paid')::int AS bookings_total,
      COALESCE(SUM(CASE WHEN ab.status='paid' THEN ab.total_amount ELSE 0 END),0)::int AS revenue_total,
      COALESCE(SUM(
        CASE
          WHEN ab.status='paid' AND COALESCE(ab.payment_method,'')='cash'
          THEN ab.total_amount
          ELSE 0
        END
      ),0)::int AS cash_total,
      COALESCE(SUM(
        CASE
          WHEN ab.status='paid' AND COALESCE(ab.payment_method,'') IN ('phonepe','upi')
          THEN ab.total_amount
          ELSE 0
        END
      ),0)::int AS upi_total
    FROM agent_bookings ab
    WHERE ab.agent_user_id=$1
    `,
    [req.userId]
  );

  const historyCountQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM agent_bookings ab
    WHERE ab.agent_user_id=$1
    `,
    [req.userId]
  );

  const historyQ = await pool.query(
    `
    SELECT
      ab.id,
      ab.payment_id,
      ab.status,
      ab.payment_method,
      ab.total_amount,
      ab.created_at,
      u.name,
      u.phone
    FROM agent_bookings ab
    JOIN users u
      ON u.id = ab.customer_user_id
    WHERE ab.agent_user_id=$1
    ORDER BY ab.created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [req.userId, pageSize, (page - 1) * pageSize]
  );

  res.render("agent/dashboard", {
    me: meQ.rows[0] || null,
    todayStats: todayQ.rows[0] || {},
    totalStats: totalQ.rows[0] || {},
    recentHistory: historyQ.rows,
    historyPage: page,
    historyPageSize: pageSize,
    historyTotalCount: Number(historyCountQ.rows[0]?.total_count || 0),
  });
});


// ==============================
// CREATE CUSTOMER
// ==============================
router.get("/agent/users/new", authMiddleware, agentMiddleware, (_req: any, res: Response) => {
 res.render("agent/create-user", {
  err: "",
  existingUser: null,
  form: { name: "", phone: "", password: "", confirmPassword: "" },
});

});

router.post(
  "/agent/users/new",
  authMiddleware,
  agentMiddleware,
  [
    body("name").trim().isLength({ min: 2, max: 150 }).withMessage("Please enter your full name."),
    body("phone").trim().custom((v) => isValidIndianMobile(v)).withMessage("Please enter a valid 10-digit Indian mobile number."),
  ],
  async (req: any, res: Response) => {
    const errors = validationResult(req);

    const name = normName(req.body.name);
    const phone = normPhone(req.body.phone);
    const autoPassword = deriveAgentCustomerPassword(name);



    const form = {
      name,
      phone,
      password: autoPassword,
      confirmPassword: autoPassword,
    };

    if (!autoPassword) {
      return res.render("agent/create-user", {
      err: "Please enter a valid name to generate password.",
      existingUser:null,
      form,
    });
}
    if (!errors.isEmpty()) {
      return res.render("agent/create-user", {
        err: errors.array()[0].msg,
        existingUser:null,
        form,
      });
    }

    try {
      const existingPhone = await pool.query(
          `SELECT id, name, phone FROM users WHERE phone=$1 LIMIT 1`,
          [phone]
        );

        if (existingPhone.rows.length > 0) {
          return res.render("agent/create-user", {
            err: "This mobile number is already registered.",
            form,
            existingUser: existingPhone.rows[0],
          });
        }



      const passwordHash = await hashPassword(autoPassword);

      const created = await pool.query(
        `INSERT INTO users (name, phone, phone_locked, email, password_hash)
         VALUES ($1, $2, true, NULL, $3)
         RETURNING id`,
        [name, phone, passwordHash]
      );

      return res.redirect(`/agent/bookings/new?customerId=${encodeURIComponent(created.rows[0].id)}`);
    } catch (e: any) {
      console.error("agent create user error:", e);
      return res.render("agent/create-user", {
        err: e?.message || "Website under maintenance, please use paper tickets.",
        existingUser:null,
        form,
      });
    }
  }
);


// ==============================
// START / LOAD DRAFT
// ==============================
router.get("/agent/bookings/new", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const customerId = String(req.query.customerId || "").trim();
  if (!customerId) return res.status(400).send("Missing customerId");

  const booking = await getOrCreateDraftBooking(String(req.userId), customerId);

  return res.redirect(`/agent/bookings/${booking.id}/contests`);
});

// ==============================
// SELECT CONTESTS
// ==============================
router.get("/agent/bookings/:bookingId/contests", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const contestsQ = await pool.query(
    `
    SELECT
      id, title, description, price, image_url
    FROM contests
    WHERE is_active=true
    ORDER BY
      CASE title
        WHEN 'Ramayana Essay Writing Contest' THEN 1
        WHEN 'Bhagavatam Essay Writing Contest' THEN 2
        WHEN 'Krishna Essay Writing Contest' THEN 3
        WHEN 'Bhagavad Gita Essay Writing Contest' THEN 4
        WHEN 'Combo Contest' THEN 5
        ELSE 999
      END,
      title ASC
    `
  );

  const qtyMap = await loadContestQtyMap(bookingId);
  const totals = await recalcBookingTotals(bookingId);

  res.render("agent/select-contest", {
    booking,
    contests: contestsQ.rows.filter((c: any) => String(c.title || "").trim().toLowerCase() !== "combo contest"),
    qtyMap,
    totalQty: totals.qty,
    bonusBookCount: totals.bonusBookCount,
    totalAmount: totals.totalAmount,

  });
});

router.post("/agent/bookings/:bookingId/items/add", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const contestId = String(req.body.contestId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const contestQ = await pool.query(
    `SELECT id, price FROM contests WHERE id=$1 AND is_active=true LIMIT 1`,
    [contestId]
  );
  if (!contestQ.rows.length) return res.redirect(`/agent/bookings/${bookingId}/contests`);

  await pool.query(
    `
    INSERT INTO agent_booking_lines (agent_booking_id, contest_id, unit_amount, line_status)
    VALUES ($1,$2,$3,'draft')
    `,
    [bookingId, contestId, Number(contestQ.rows[0].price || 0)]
  );

  await recalcBookingTotals(bookingId);
  return res.redirect(`/agent/bookings/${bookingId}/contests`);
});

router.post("/agent/bookings/:bookingId/items/remove", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const contestId = String(req.body.contestId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lineQ = await pool.query(
    `
    SELECT id
    FROM agent_booking_lines
    WHERE agent_booking_id=$1
      AND contest_id=$2
      AND line_status='draft'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [bookingId, contestId]
  );

  if (lineQ.rows.length) {
    await pool.query(`DELETE FROM agent_booking_lines WHERE id=$1`, [lineQ.rows[0].id]);
    await recalcBookingTotals(bookingId);
  }

  return res.redirect(`/agent/bookings/${bookingId}/contests`);
});

router.post("/agent/bookings/:bookingId/items/delete", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const contestId = String(req.body.contestId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  await pool.query(
    `
    DELETE FROM agent_booking_lines
    WHERE agent_booking_id=$1
      AND contest_id=$2
      AND line_status='draft'
    `,
    [bookingId, contestId]
  );

  await recalcBookingTotals(bookingId);
  return res.redirect(`/agent/bookings/${bookingId}/contests`);
});

router.post("/agent/bookings/:bookingId/cancel", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  if (String(booking.status || "") === "paid") {
    return res.status(400).send("Paid bookings cannot be deleted.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (booking.payment_session_id) {
      await client.query(
        `
        DELETE FROM orders
        WHERE payment_session_id = $1
          AND COALESCE(payment_status, 'pending') <> 'paid'
        `,
        [booking.payment_session_id]
      );

      await client.query(
        `
        DELETE FROM payment_sessions
        WHERE id = $1
          AND COALESCE(status, 'pending') <> 'paid'
        `,
        [booking.payment_session_id]
      );
    } else if (booking.payment_id) {
      await client.query(
        `
        DELETE FROM orders
        WHERE payment_id = $1
          AND COALESCE(payment_status, 'pending') <> 'paid'
        `,
        [booking.payment_id]
      );
    }

    await client.query(`DELETE FROM agent_booking_bonus_items WHERE agent_booking_id=$1`, [bookingId]);
    await client.query(`DELETE FROM agent_booking_lines WHERE agent_booking_id=$1`, [bookingId]);
    await client.query(`DELETE FROM agent_bookings WHERE id=$1`, [bookingId]);

    await client.query("COMMIT");
    return res.redirect("/agent");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("agent cancel/delete error:", e);
    return res.status(500).send("Failed to delete unfinished booking");
  } finally {
    client.release();
  }
});

// ==============================
// CHECKOUT
// ==============================
router.get("/agent/bookings/:bookingId/checkout", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);
  if (!lines.length) return res.redirect(`/agent/bookings/${bookingId}/contests`);

  const availableBookLanguages = await fetchAvailableBookLanguages();
  const selectableBooks = await fetchSelectableBookTitles();

const orders = lines.map((row: any) => {
  const selectedBook = String(row.book_title || row.default_book_title || "").trim();
  return {
    line_id: row.id,
    contest_id: row.contest_id,
    contest_title: row.contest_title,
    amount: Number(row.unit_amount || 0),
    selected_book_title: selectedBook,
    age_category: String(row.age_category || "0-25").trim(),
    saved_book_language: String(row.book_language || "").trim(),
    available_books: selectableBooks,
    available_languages: availableBookLanguages[selectedBook] || [],
  };
});

  const ssrCount = calcSsrCount(orders.length);
  const ssrLanguages = availableBookLanguages["Science of Self Realization"] || [];

  res.render("agent/checkout-review", {
    booking,
    paymentId: "",
    orders,
    deliveryMode: booking.delivery_mode || "handover",
    error: null,
    ssrCount,
    ssrSelectedLanguages: [],
    ssrLanguages,
    availableBookLanguages,
  });
});

router.post("/agent/bookings/:bookingId/checkout", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);
  if (!lines.length) return res.redirect(`/agent/bookings/${bookingId}/contests`);

  const availableBookLanguages = await fetchAvailableBookLanguages();

  const selectableBooks = await fetchSelectableBookTitles();

const selectedBooks = ([] as any[]).concat(req.body.bookTitle || []).map((x) => String(x || "").trim());

  const orders = lines.map((row: any, idx: number) => {
  const selectedBook = selectedBooks[idx] || String(row.book_title || row.default_book_title || "").trim();

  return {
    line_id: row.id,
    contest_id: row.contest_id,
    contest_title: row.contest_title,
    amount: Number(row.unit_amount || 0),
    selected_book_title: selectedBook,
    age_category: String(([] as any[]).concat(req.body.ageCategory || [])[idx] || "0-25").trim(),
    saved_book_language: String(([] as any[]).concat(req.body.bookLanguage || [])[idx] || "").trim(),
    available_books: selectableBooks,
    available_languages: availableBookLanguages[selectedBook] || [],
  };
});

  const ssrCount = calcSsrCount(orders.length);
  const ssrLanguages = availableBookLanguages["Science of Self Realization"] || [];
  const ssrSelectedLanguages = ([] as any[]).concat(req.body.ssrLanguage || []).map((x) => String(x || "").trim());

  const renderError = (msg: string) => {
    return res.render("agent/checkout-review", {
      booking,
      paymentId: "",
      orders,
      deliveryMode: String(req.body.deliveryMode || "handover"),
      error: msg,
      ssrCount,
      ssrSelectedLanguages,
      ssrLanguages,
      availableBookLanguages,
    });
  };

  const fullName = norm(req.body.fullName || booking.customer_name || "");
  const phoneStr = normPhone(req.body.phone || booking.customer_phone || "");
  const deliveryMode = String(req.body.deliveryMode || "").trim();
  const paymentMethod = String(req.body.offlineMethod || "cash").trim().toLowerCase();

  if (fullName.length < 2) return renderError("Receiver name is required.");
  if (!isValidIndianMobile(phoneStr)) return renderError("Please enter a valid 10-digit mobile number.");
  if (!["handover", "donate"].includes(deliveryMode)) return renderError("Please choose Handover or Donate.");
  if (!["cash", "phonepe"].includes(paymentMethod)) return renderError("Please choose payment method.");

 for (let i = 0; i < orders.length; i++) {
  const age = String(orders[i].age_category || "").trim();
  if (!["0-25", "above-25"].includes(age)) {
    return renderError("Please choose valid age category for every contest row.");
  }

  if (deliveryMode === "handover") {
    const selectedBook = String(orders[i].selected_book_title || "").trim();
    const lang = String(orders[i].saved_book_language || "").trim();
    const allowedLanguages = orders[i].available_languages || [];

    if (!selectedBook) return renderError("Please select a book for every contest row.");
    if (!lang) return renderError("Please select language for every contest row.");
    if (!allowedLanguages.includes(lang)) {
      return renderError(`Selected language is not available for ${selectedBook}.`);
    }
  }
}

  if (deliveryMode === "handover") {
    if (ssrSelectedLanguages.length !== ssrCount) {
      return renderError("Please select language for all free Science of Self Realization books.");
    }
    for (let i = 0; i < ssrCount; i++) {
      if (!String(ssrSelectedLanguages[i] || "").trim()) {
        return renderError("Please select language for all free Science of Self Realization books.");
      }
    }
  }

  const paymentId = genAgentPaymentId();
  const totalAmount = orders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
  const offlinePaymentRef = paymentMethod === "phonepe"
    ? `OFFLINE_PHONEPE_${paymentId}`
    : `OFFLINE_CASH_${paymentId}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ps = await client.query(
      `
      INSERT INTO payment_sessions (user_id, payment_id, amount, status)
      VALUES ($1,$2,$3,'pending')
      RETURNING id
      `,
      [booking.customer_user_id, offlinePaymentRef, totalAmount]
    );
    const paymentSessionId = ps.rows[0].id;

    for (let i = 0; i < orders.length; i++) {
      const row = orders[i];
      const bookOption = deliveryMode === "donate" ? "donation" : "book";

      const ins = await client.query(
        `
        INSERT INTO orders
          (user_id, contest_id, amount, payment_status, payment_id, payment_session_id, age_category, created_at, book_option, full_name, book_title)
        VALUES
          ($1,$2,$3,'pending',$4,$5,$6,(NOW() AT TIME ZONE 'Asia/Kolkata'),$7,$8,$9)
        RETURNING id
        `,
        [
          booking.customer_user_id,
          row.contest_id,
          Number(row.amount || 0),
          paymentId,
          paymentSessionId,
          row.age_category,
          bookOption,
          fullName,
          deliveryMode === "handover" ? row.selected_book_title : null,
        ]
      );

      await client.query(
        `
        UPDATE agent_booking_lines
        SET order_id=$2,
            age_category=$3,
            book_title=$4,
            book_language=$5,
            line_status='pending_payment',
            updated_at=NOW()
        WHERE id=$1
        `,
        [
          row.line_id,
          ins.rows[0].id,
          row.age_category,
          deliveryMode === "handover" ? row.selected_book_title : null,
          deliveryMode === "handover" ? row.saved_book_language : null,
        ]
      );
    }

    await client.query(`DELETE FROM agent_booking_bonus_items WHERE agent_booking_id=$1`, [bookingId]);

    if (deliveryMode === "handover") {
      for (let i = 0; i < ssrCount; i++) {
        await client.query(
          `
          INSERT INTO agent_booking_bonus_items (agent_booking_id, book_title, book_language, quantity)
          VALUES ($1,$2,$3,1)
          `,
          [bookingId, "Science of Self Realization", ssrSelectedLanguages[i]]
        );
      }
    }

    await client.query(
      `
      UPDATE agent_bookings
      SET status='checkout_pending',
          payment_id=$2,
          payment_session_id=$3,
          payment_method=$4,
          delivery_mode=$5,
          full_name=$6,
          phone=$7,
          total_amount=$8,
          bonus_book_count=$9,
          updated_at=NOW()
      WHERE id=$1
      `,
      [
        bookingId,
        paymentId,
        paymentSessionId,
        paymentMethod,
        deliveryMode,
        fullName,
        phoneStr,
        totalAmount,
        ssrCount,
      ]
    );

    await client.query("COMMIT");
    return res.redirect(`/agent/bookings/${bookingId}/payment`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("agent checkout error:", e);
    return res.status(500).send("Failed to create pending booking");
  } finally {
    client.release();
  }
});

// ==============================
// PAYMENT
// ==============================
router.get("/agent/bookings/:bookingId/payment", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);

  res.render("agent/payment", {
    booking,
    orders: lines.map((x: any) => ({
      contest_title: x.contest_title,
      amount: x.unit_amount,
    })),
  });
});

router.post("/agent/bookings/:bookingId/payment/complete", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");
  if (!booking.payment_session_id) return res.status(400).send("Payment session missing");
  if (!booking.payment_id) return res.status(400).send("Payment id missing");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const offlinePaymentRef = booking.payment_method === "phonepe"
      ? `OFFLINE_PHONEPE_${booking.payment_id}`
      : `OFFLINE_CASH_${booking.payment_id}`;

    await client.query(
      `UPDATE payment_sessions SET payment_id=$1, status='paid' WHERE id=$2`,
      [offlinePaymentRef, booking.payment_session_id]
    );

    await client.query(
      `UPDATE orders SET payment_status='paid' WHERE payment_session_id=$1`,
      [booking.payment_session_id]
    );

    await client.query(
      `UPDATE agent_booking_lines SET line_status='paid', updated_at=NOW() WHERE agent_booking_id=$1`,
      [bookingId]
    );

    await client.query(
      `UPDATE agent_bookings SET status='paid', updated_at=NOW() WHERE id=$1`,
      [bookingId]
    );

    await client.query("COMMIT");

    try {
      const contestsQ = await pool.query(
        `
        SELECT c.title
        FROM agent_booking_lines abl
        JOIN contests c ON c.id = abl.contest_id
        WHERE abl.agent_booking_id=$1
        ORDER BY abl.created_at ASC
        `,
        [bookingId]
      );


      await sendOfflineRegistrationMessageOnce({
  paymentId: String(booking.payment_id || ""),
  paymentSessionId: booking.payment_session_id ? String(booking.payment_session_id) : null,
  userId: String(booking.customer_user_id || ""),
  phone: String(booking.customer_phone || ""),
  userName: String(booking.customer_name || "Participant"),
  contestTitles: contestsQ.rows.map((r: any) => String(r.title || "").trim()).filter(Boolean),
  loginHelpText: `Mobile Number: ${String(booking.customer_phone || "")}. Password reset link https://iskconcontest.org/forgot-password.`,
});

    } catch (e) {
      console.error("agent confirmation send error:", e);
    }

    return res.redirect(`/agent/bookings/${bookingId}/summary`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("agent payment complete error:", e);
    return res.status(500).send("Payment completion failed");
  } finally {
    client.release();
  }
});

// ==============================
// SUMMARY
// ==============================
router.get("/agent/bookings/:bookingId/summary", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();

  const booking = await loadBookingForAgent(bookingId, String(req.userId));

  if (!booking)
    return res.status(404).send("Booking not found");

  const bookingTimeQ = await pool.query(
  `
  SELECT to_char(
    booking_ts AT TIME ZONE 'Asia/Kolkata',
    'FMDD Mon YYYY "at" FMHH12:MI am'
  ) AS booking_created_at_ist
  FROM (
    SELECT $1::timestamptz AS booking_ts
  ) t
  `,
  [booking.created_at]
);

const bookingCreatedAtIst =
  bookingTimeQ.rows[0]?.booking_created_at_ist || "-";

  const lines = await loadBookingLines(bookingId);

  const bonusQ = await pool.query(
    `
    SELECT *
    FROM agent_booking_bonus_items
    WHERE agent_booking_id=$1
    ORDER BY created_at ASC
    `,
    [bookingId]
  );

  const loginName = String(booking.customer_name || booking.full_name || "").trim();
  const loginPhone = String(booking.customer_phone || booking.phone || "").trim();
  const loginPassword = deriveAgentCustomerPassword(loginName);

  res.render("agent/summary", {
    booking,
    orders: lines,
    bonusItems: bonusQ.rows,
    whatsappNumber: "9493805059",
    bookingCreatedAtIst,
    portalCredentials: {
      phone: loginPhone,
      password: loginPassword,
    },
  });
});


async function loadBookingBonusItems(bookingId: string) {
  const q = await pool.query(
    `
    SELECT *
    FROM agent_booking_bonus_items
    WHERE agent_booking_id=$1
    ORDER BY created_at ASC
    `,
    [bookingId]
  );
  return q.rows;
}

router.get("/agent/history", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const qText = norm(req.query.q || "");
  const qLower = qText.toLowerCase();
  const qDigits = normPhone(qText);

  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 5;

  const whereSql = `
    ab.agent_user_id=$1
    AND (
      $2 = ''
      OR LOWER(COALESCE(u.name,'')) LIKE $3
      OR COALESCE(u.phone,'') LIKE $4
    )
  `;

  const paramsBase = [
    req.userId,
    qText,
    `%${qLower}%`,
    `%${qDigits}%`,
  ];

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM agent_bookings ab
    JOIN users u ON u.id = ab.customer_user_id
    WHERE ${whereSql}
    `,
    paramsBase
  );


  const historyQ = await pool.query(
  `
  SELECT
    ab.id,
    ab.payment_id,
    ab.status,
    ab.payment_method,
    ab.total_amount,
    ab.created_at,
    to_char(
      timezone('Asia/Kolkata', ab.created_at AT TIME ZONE 'UTC'),
      'FMDD Mon YYYY "at" FMHH12:MI am'
    ) AS created_at_ist,
    u.name,
    u.phone,
    COALESCE(line_counts.lines_count, 0)::int AS lines_count
  FROM agent_bookings ab
  JOIN users u ON u.id = ab.customer_user_id
  LEFT JOIN (
    SELECT
      agent_booking_id,
      COUNT(*)::int AS lines_count
    FROM agent_booking_lines
    WHERE COALESCE(line_status,'') <> 'cancelled'
    GROUP BY agent_booking_id
  ) line_counts
    ON line_counts.agent_booking_id = ab.id
  WHERE ${whereSql}
  ORDER BY ab.created_at DESC
  LIMIT $5 OFFSET $6
  `,
  [...paramsBase, pageSize, (page - 1) * pageSize]
);

  res.render("agent/history", {
    q: qText,
    bookings: historyQ.rows,
    page,
    pageSize,
    filteredCount: Number(countQ.rows[0]?.total_count || 0),
  });
});

// ==============================
// USERS LIST
// ==============================
router.get("/agent/users", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const qRaw = norm(req.query.q || "");
  const qDigits = normPhone(qRaw);
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 5;

  let err = "";
  let users: any[] = [];
  let filteredCount = 0;

  // -------------------------------------------------
  // MODE 1: exact 10-digit phone search across users
  // -------------------------------------------------
  if (qRaw) {
    if (!/^\d{10}$/.test(qRaw)) {
      err = "Please enter exactly 10 digits.";
    } else {
      const searchQ = await pool.query(
        `
        SELECT
          u.id,
          u.name,
          u.phone,
          stats.first_seen_at,
          stats.last_booking_at,
          COALESCE(stats.bookings_count, 0)::int AS bookings_count,
          COALESCE(stats.paid_bookings_count, 0)::int AS paid_bookings_count,
          COALESCE(stats.draft_bookings_count, 0)::int AS draft_bookings_count,
          COALESCE(stats.pending_bookings_count, 0)::int AS pending_bookings_count,
          COALESCE(stats.cancelled_bookings_count, 0)::int AS cancelled_bookings_count,
          COALESCE(stats.latest_status, 'none') AS latest_status
        FROM users u
        LEFT JOIN (
          SELECT
            ab.customer_user_id,
            MIN(ab.created_at) AS first_seen_at,
            MAX(ab.created_at) AS last_booking_at,
            COUNT(ab.id)::int AS bookings_count,
            COUNT(*) FILTER (WHERE ab.status='paid')::int AS paid_bookings_count,
            COUNT(*) FILTER (WHERE ab.status='draft')::int AS draft_bookings_count,
            COUNT(*) FILTER (WHERE ab.status='checkout_pending')::int AS pending_bookings_count,
            COUNT(*) FILTER (WHERE ab.status='cancelled')::int AS cancelled_bookings_count,
            (
              SELECT ab2.status
              FROM agent_bookings ab2
              WHERE ab2.agent_user_id = $1
                AND ab2.customer_user_id = ab.customer_user_id
              ORDER BY ab2.created_at DESC
              LIMIT 1
            ) AS latest_status
          FROM agent_bookings ab
          WHERE ab.agent_user_id = $1
          GROUP BY ab.customer_user_id
        ) stats
          ON stats.customer_user_id = u.id
        WHERE u.phone = $2
        LIMIT 1
        `,
        [req.userId, qDigits]
      );

      users = searchQ.rows;
      filteredCount = users.length;
    }

    return res.render("agent/users", {
      q: qRaw,
      err,
      users,
      page: 1,
      pageSize,
      filteredCount,
      totalAll: 0,
      isSearchMode: true,
    });
  }

  // -------------------------------------------------
  // MODE 2: default page = only this agent's users
  // -------------------------------------------------
  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM (
      SELECT ab.customer_user_id
      FROM agent_bookings ab
      WHERE ab.agent_user_id = $1
      GROUP BY ab.customer_user_id
    ) x
    `,
    [req.userId]
  );

  const usersQ = await pool.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      MIN(ab.created_at) AS first_seen_at,
      MAX(ab.created_at) AS last_booking_at,
      COUNT(ab.id)::int AS bookings_count,
      COUNT(*) FILTER (WHERE ab.status='paid')::int AS paid_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='draft')::int AS draft_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='checkout_pending')::int AS pending_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='cancelled')::int AS cancelled_bookings_count,
      COALESCE((
        SELECT ab2.status
        FROM agent_bookings ab2
        WHERE ab2.agent_user_id = $1
          AND ab2.customer_user_id = u.id
        ORDER BY ab2.created_at DESC
        LIMIT 1
      ), 'none') AS latest_status
    FROM agent_bookings ab
    JOIN users u ON u.id = ab.customer_user_id
    WHERE ab.agent_user_id = $1
    GROUP BY u.id, u.name, u.phone
    ORDER BY MAX(ab.created_at) DESC, u.name ASC
    LIMIT $2 OFFSET $3
    `,
    [req.userId, pageSize, (page - 1) * pageSize]
  );

  res.render("agent/users", {
    q: "",
    err: "",
    users: usersQ.rows,
    page,
    pageSize,
    filteredCount: Number(countQ.rows[0]?.total_count || 0),
    totalAll: Number(countQ.rows[0]?.total_count || 0),
    isSearchMode: false,
  });
});




/*
router.get("/agent/users", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const qText = norm(req.query.q || "");
  const qLower = qText.toLowerCase();
  const qDigits = normPhone(qText);

  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 5;

  const whereSql = `
    ab.agent_user_id=$1
    AND (
      $2 = ''
      OR LOWER(COALESCE(u.name,'')) LIKE $3
      OR COALESCE(u.phone,'') LIKE $4
    )
  `;

  const paramsBase = [
    req.userId,
    qText,
    `%${qLower}%`,
    `%${qDigits}%`,
  ];

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM (
      SELECT u.id
      FROM agent_bookings ab
      JOIN users u ON u.id = ab.customer_user_id
      WHERE ${whereSql}
      GROUP BY u.id
    ) x
    `,
    paramsBase
  );

  const totalAllQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_all
    FROM (
      SELECT customer_user_id
      FROM agent_bookings
      WHERE agent_user_id=$1
      GROUP BY customer_user_id
    ) x
    `,
    [req.userId]
  );

  const usersQ = await pool.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      MIN(ab.created_at) AS first_seen_at,
      MAX(ab.created_at) AS last_booking_at,
      COUNT(ab.id)::int AS bookings_count,
      COUNT(*) FILTER (WHERE ab.status='paid')::int AS paid_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='draft')::int AS draft_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='checkout_pending')::int AS pending_bookings_count,
      COUNT(*) FILTER (WHERE ab.status='cancelled')::int AS cancelled_bookings_count,
      COALESCE((
        SELECT ab2.status
        FROM agent_bookings ab2
        WHERE ab2.agent_user_id=$1
          AND ab2.customer_user_id=u.id
        ORDER BY ab2.created_at DESC
        LIMIT 1
      ), 'none') AS latest_status
    FROM agent_bookings ab
    JOIN users u ON u.id = ab.customer_user_id
    WHERE ${whereSql}
    GROUP BY u.id, u.name, u.phone
    ORDER BY MAX(ab.created_at) DESC, u.name ASC
    LIMIT $5 OFFSET $6
    `,
    [...paramsBase, pageSize, (page - 1) * pageSize]
  );

  res.render("agent/users", {
    q: qText,
    users: usersQ.rows,
    page,
    pageSize,
    filteredCount: Number(countQ.rows[0]?.total_count || 0),
    totalAll: Number(totalAllQ.rows[0]?.total_all || 0),
  });
});
*/

// ==============================
// USER HISTORY
// ==============================
/*
router.get("/agent/users/:customerId", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const customerId = String(req.params.customerId || "").trim();
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 5;

  const customerQ = await pool.query(
    `
    SELECT u.id, u.name, u.phone
    FROM users u
    WHERE u.id=$1
      AND EXISTS (
        SELECT 1
        FROM agent_bookings ab
        WHERE ab.agent_user_id=$2
          AND ab.customer_user_id=u.id
      )
    LIMIT 1
    `,
    [customerId, req.userId]
  );

  const customer = customerQ.rows[0];
  if (!customer) return res.status(404).send("Customer not found");

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM agent_bookings ab
    WHERE ab.agent_user_id=$1
      AND ab.customer_user_id=$2
    `,
    [req.userId, customerId]
  );

  const bookingsQ = await pool.query(
    `
    SELECT
      ab.id,
      ab.payment_id,
      ab.status,
      ab.payment_method,
      ab.total_amount,
      ab.created_at,
      COALESCE(line_counts.lines_count, 0)::int AS lines_count
    FROM agent_bookings ab
    LEFT JOIN (
      SELECT
        agent_booking_id,
        COUNT(*)::int AS lines_count
      FROM agent_booking_lines
      WHERE line_status <> 'cancelled'
      GROUP BY agent_booking_id
    ) line_counts
      ON line_counts.agent_booking_id = ab.id
    WHERE ab.agent_user_id=$1
      AND ab.customer_user_id=$2
    ORDER BY ab.created_at DESC
    LIMIT $3 OFFSET $4
    `,
    [req.userId, customerId, pageSize, (page - 1) * pageSize]
  );

  res.render("agent/user-history", {
    customer,
    bookings: bookingsQ.rows,
    page,
    pageSize,
    totalCount: Number(countQ.rows[0]?.total_count || 0),
  });
});
*/

// ==============================
// USER HISTORY
// ==============================
router.get("/agent/users/:customerId", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const customerId = String(req.params.customerId || "").trim();
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = 5;

  const customerQ = await pool.query(
    `
    SELECT u.id, u.name, u.phone
    FROM users u
    WHERE u.id = $1
    LIMIT 1
    `,
    [customerId]
  );

  const customer = customerQ.rows[0];
  if (!customer) return res.status(404).send("Customer not found");

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total_count
    FROM agent_bookings ab
    WHERE ab.agent_user_id = $1
      AND ab.customer_user_id = $2
    `,
    [req.userId, customerId]
  );


    const historyQ = await pool.query(
    `
    SELECT
      ab.id,
      ab.payment_id,
      ab.status,
      ab.payment_method,
      ab.total_amount,
      ab.created_at,
      to_char(
  timezone('Asia/Kolkata', ab.created_at AT TIME ZONE 'UTC'),
  'FMDD Mon YYYY "at" FMHH12:MI am'
) AS created_at_ist,
      COALESCE(lines.contests_count, 0)::int AS contests_count
    FROM agent_bookings ab
    LEFT JOIN (
      SELECT
        abl.agent_booking_id,
        COUNT(*)::int AS contests_count
      FROM agent_booking_lines abl
      WHERE abl.line_status <> 'cancelled'
      GROUP BY abl.agent_booking_id
    ) lines
      ON lines.agent_booking_id = ab.id
    WHERE ab.agent_user_id = $1
      AND ab.customer_user_id = $2
    ORDER BY ab.created_at DESC
    LIMIT $3 OFFSET $4
    `,
    [req.userId, customerId, pageSize, (page - 1) * pageSize]
  );


  res.render("agent/user-history", {
    customer,
    bookings: historyQ.rows,
    page,
    pageSize,
    totalCount: Number(countQ.rows[0]?.total_count || 0),
  });
});


// ==============================
// BOOKING DETAIL
// ==============================
router.get("/agent/bookings/:bookingId", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const from = norm(req.query.from || "history");

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);
  const bonusItems = await loadBookingBonusItems(bookingId);

  res.render("agent/booking-detail", {
    booking,
    orders: lines,
    bonusItems,
    from,
  });
});




// ==============================
// EDIT DETAILS (SAFE FOR PAID / PENDING)
// ==============================
router.get("/agent/bookings/:bookingId/edit-details", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const from = norm(req.query.from || "history");

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);
  if (!lines.length) return res.redirect(`/agent/bookings/${bookingId}`);

  const availableBookLanguages = await fetchAvailableBookLanguages();
  const allBookTitles = await fetchSelectableBookTitles();

  const editableOrders = lines.map((row: any) => {
    const currentBook = String(row.book_title || row.default_book_title || "").trim();

    return {
      line_id: row.id,
      contest_title: row.contest_title,
      selected_book_title: currentBook,
      age_category: String(row.age_category || "0-25").trim(),
      saved_book_language: String(row.book_language || "").trim(),
      available_books: allBookTitles,
      available_languages: availableBookLanguages[currentBook] || [],
      amount: Number(row.unit_amount || 0),
    };
  });

  res.render("agent/edit-booking-details", {
    booking,
    orders: editableOrders,
    err: "",
    ok: norm(req.query.ok || ""),
    from,
    availableBookLanguages,
  });
});

router.post("/agent/bookings/:bookingId/edit-details", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const bookingId = String(req.params.bookingId || "").trim();
  const from = norm(req.body.from || "history");

  const booking = await loadBookingForAgent(bookingId, String(req.userId));
  if (!booking) return res.status(404).send("Booking not found");

  const lines = await loadBookingLines(bookingId);
  if (!lines.length) return res.redirect(`/agent/bookings/${bookingId}`);

  const availableBookLanguages = await fetchAvailableBookLanguages();
  const allBookTitles = await fetchSelectableBookTitles();

  const selectedBooks = ([] as any[]).concat(req.body.bookTitle || []).map((x) => String(x || "").trim());
  const selectedAges = ([] as any[]).concat(req.body.ageCategory || []).map((x) => String(x || "").trim());
  const selectedLangs = ([] as any[]).concat(req.body.bookLanguage || []).map((x) => String(x || "").trim());

  const editableOrders = lines.map((row: any, idx: number) => {
    const currentBook = selectedBooks[idx] || String(row.book_title || row.default_book_title || "").trim();

    return {
      line_id: row.id,
      contest_title: row.contest_title,
      selected_book_title: currentBook,
      age_category: selectedAges[idx] || String(row.age_category || "0-25").trim(),
      saved_book_language: selectedLangs[idx] || String(row.book_language || "").trim(),
      available_books: allBookTitles,
      available_languages: availableBookLanguages[currentBook] || [],
      amount: Number(row.unit_amount || 0),
    };
  });

  const renderError = (msg: string) => {
    return res.render("agent/edit-booking-details", {
      booking,
      orders: editableOrders,
      err: msg,
      ok: "",
      from,
      availableBookLanguages,
    });
  };

  const fullName = norm(req.body.fullName || booking.full_name || booking.customer_name || "");
  const phoneStr = normPhone(req.body.phone || booking.phone || booking.customer_phone || "");
  const deliveryMode = String(req.body.deliveryMode || booking.delivery_mode || "handover").trim();

  if (fullName.length < 2) return renderError("Receiver name is required.");
  if (!isValidIndianMobile(phoneStr)) return renderError("Please enter a valid 10-digit mobile number.");
  if (!["handover", "donate"].includes(deliveryMode)) return renderError("Please choose valid delivery mode.");

  for (let i = 0; i < editableOrders.length; i++) {
    const age = String(editableOrders[i].age_category || "").trim();
    const selectedBook = String(editableOrders[i].selected_book_title || "").trim();
    const lang = String(editableOrders[i].saved_book_language || "").trim();
    const allowedLanguages = editableOrders[i].available_languages || [];

    if (!["0-25", "above-25"].includes(age)) {
      return renderError("Please choose valid age category for every contest row.");
    }

    if (deliveryMode === "handover") {
      if (!selectedBook) return renderError("Please select a book for every contest row.");
      if (!lang) return renderError("Please select language for every row.");
      if (!allowedLanguages.includes(lang)) {
        return renderError(`Selected language is not available for ${selectedBook}.`);
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE agent_bookings
      SET full_name=$2,
          phone=$3,
          delivery_mode=$4,
          updated_at=NOW()
      WHERE id=$1
      `,
      [bookingId, fullName, phoneStr, deliveryMode]
    );

    for (let i = 0; i < lines.length; i++) {
      await client.query(
        `
        UPDATE agent_booking_lines
        SET age_category=$2,
            book_title=$3,
            book_language=$4,
            updated_at=NOW()
        WHERE id=$1
        `,
        [
          lines[i].id,
          editableOrders[i].age_category,
          deliveryMode === "handover" ? editableOrders[i].selected_book_title : null,
          deliveryMode === "handover" ? editableOrders[i].saved_book_language : null,
        ]
      );
    }

    await client.query("COMMIT");
    return res.redirect(`/agent/bookings/${bookingId}/edit-details?from=${encodeURIComponent(from)}&ok=saved`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("agent edit details error:", e);
    return renderError("Failed to update booking details.");
  } finally {
    client.release();
  }
});


async function loadBookingLineByIdForAgent(lineId: string, bookingId: string, agentUserId: string) {
  const q = await pool.query(
    `
    SELECT
      abl.*,
      ab.status AS booking_status,
      c.title AS contest_title,
      c.default_book_title
    FROM agent_booking_lines abl
    JOIN agent_bookings ab
      ON ab.id = abl.agent_booking_id
    JOIN contests c
      ON c.id = abl.contest_id
    WHERE abl.id=$1
      AND abl.agent_booking_id=$2
      AND ab.agent_user_id=$3
    LIMIT 1
    `,
    [lineId, bookingId, agentUserId]
  );
  return q.rows[0] || null;
}


router.post("/agent/bookings/:bookingId/refund", authMiddleware, agentMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { bookingId } = req.params;
    const { note } = req.body;

    await client.query("BEGIN");

    await client.query(
      `UPDATE agent_bookings
       SET is_refunded = true,
           refund_note = $2
       WHERE id = $1`,
      [bookingId, note || 'Refunded manually']
    );

    await client.query("COMMIT");

    const from = req.query.from;
    const customerId = req.query.customerId;

    if (from === "user-history" && customerId) {
      return res.redirect(`/agent/users/${customerId}`);
    }

    return res.redirect("/agent/history");

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("refund error:", e);
    return res.status(500).send("Failed to mark refunded");
  } finally {
    client.release();
  }
});


router.get("/agent/profile", authMiddleware, agentMiddleware, async (req: any, res: Response) => {
  const meQ = await pool.query(
    `SELECT id, name, phone FROM users WHERE id=$1 LIMIT 1`,
    [req.userId]
  );

  const me = meQ.rows[0];
  if (!me) return res.status(404).send("Agent not found");

  return res.render("agent/profile", {
    me,
    error: "",
    success: "",
    pwError: "",
    pwSuccess: "",
  });
});

router.post(
  "/agent/profile",
  authMiddleware,
  agentMiddleware,
  [
    body("name")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Please enter a valid name."),
  ],
  async (req: any, res: Response) => {
    const meQ = await pool.query(
      `SELECT id, name, phone FROM users WHERE id=$1 LIMIT 1`,
      [req.userId]
    );

    const me = meQ.rows[0];
    if (!me) return res.status(404).send("Agent not found");

    const errors = validationResult(req);
    const newName = normName(req.body.name);

    if (!errors.isEmpty()) {
      return res.render("agent/profile", {
        me: { ...me, name: newName },
        error: errors.array()[0].msg,
        success: "",
        pwError: "",
        pwSuccess: "",
      });
    }

    try {
      await pool.query(
        `UPDATE users SET name=$2 WHERE id=$1`,
        [req.userId, newName]
      );

      return res.render("agent/profile", {
        me: { ...me, name: newName },
        error: "",
        success: "Profile updated successfully.",
        pwError: "",
        pwSuccess: "",
      });
    } catch (e) {
      console.error("agent profile update error:", e);
      return res.render("agent/profile", {
        me: { ...me, name: newName },
        error: "Failed to update profile.",
        success: "",
        pwError: "",
        pwSuccess: "",
      });
    }
  }
);

router.post(
  "/agent/profile/reset-password",
  authMiddleware,
  agentMiddleware,
  [
    body("newPassword")
      .isLength({ min: 6, max: 100 })
      .withMessage("Password must be at least 6 characters."),
    body("confirmPassword")
      .isLength({ min: 6, max: 100 })
      .withMessage("Please confirm password."),
  ],
  async (req: any, res: Response) => {
    const meQ = await pool.query(
      `SELECT id, name, phone FROM users WHERE id=$1 LIMIT 1`,
      [req.userId]
    );

    const me = meQ.rows[0];
    if (!me) return res.status(404).send("Agent not found");

    const errors = validationResult(req);
    const newPassword = String(req.body.newPassword || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (!errors.isEmpty()) {
      return res.render("agent/profile", {
        me,
        error: "",
        success: "",
        pwError: errors.array()[0].msg,
        pwSuccess: "",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render("agent/profile", {
        me,
        error: "",
        success: "",
        pwError: "Passwords do not match.",
        pwSuccess: "",
      });
    }

    try {
      const passwordHash = await hashPassword(newPassword);

      await pool.query(
        `UPDATE users SET password_hash=$2 WHERE id=$1`,
        [req.userId, passwordHash]
      );

      return res.render("agent/profile", {
        me,
        error: "",
        success: "",
        pwError: "",
        pwSuccess: "Password reset successfully.",
      });
    } catch (e) {
      console.error("agent password reset error:", e);
      return res.render("agent/profile", {
        me,
        error: "",
        success: "",
        pwError: "Failed to reset password.",
        pwSuccess: "",
      });
    }
  }
);

export default router;
