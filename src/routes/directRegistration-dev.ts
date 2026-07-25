// src/routes/directRegistration.ts
import express from "express";
import { pool } from "../config/db";
import { generateToken } from "../utils/jwt";

const router = express.Router();

const normPhone = (v: string) => String(v || "").replace(/\D/g, "").slice(-10);
const norm = (v: any) => String(v || "").trim();

function setAuthCookie(res: any, token: string) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

type BookLanguageMap = Record<string, string[]>;

async function fetchAvailableBookLanguages(): Promise<BookLanguageMap> {
  const q = await pool.query(`
    SELECT TRIM(book_title) AS book_title, TRIM(book_language) AS book_language
    FROM shipment_book_stock
    WHERE COALESCE(stock_qty, 0) > 0
      AND COALESCE(TRIM(book_title), '') <> ''
      AND COALESCE(TRIM(book_language), '') <> ''
    ORDER BY book_title ASC, book_language ASC
  `);

  const map: BookLanguageMap = {};
  for (const row of q.rows) {
    const b = String(row.book_title || "").trim();
    const l = String(row.book_language || "").trim();
    if (!b || !l) continue;
    if (!map[b]) map[b] = [];
    if (!map[b].includes(l)) map[b].push(l);
  }
  return map;
}

const CONTEST_MAP: Record<string, string[]> = {
  ramayana: ["Ramayana Essay Writing Contest"],
  bhagavatam: ["Bhagavatam Essay Writing Contest"],
  krishna: ["Krishna Essay Writing Contest"],
  gita: ["Bhagavad Gita Essay Writing Contest"],
  combo: [
    "Ramayana Essay Writing Contest",
    "Bhagavatam Essay Writing Contest",
    "Krishna Essay Writing Contest",
    "Bhagavad Gita Essay Writing Contest",
  ],
};

function normalizeDeliveryMode(v: string): "home_delivery" | "temple_pickup" | "donate" | "" {
  const x = String(v || "").trim().toLowerCase();
  if (x === "deliver" || x === "home" || x === "home_delivery") return "home_delivery";
  if (x === "temple" || x === "temple_pickup") return "temple_pickup";
  if (x === "donate" || x === "donation") return "donate";
  return "";
}

async function generateUniqueInternalPaymentId(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = "KNC" + Math.random().toString(36).slice(2, 10).toUpperCase();
    const q = await pool.query(`SELECT 1 FROM orders WHERE payment_id=$1 LIMIT 1`, [id]);
    if (!q.rows.length) return id;
  }
  throw new Error("paymentId collision");
}

// ─── POST /join/:category ─────────────────────────────────────────────────────
router.post("/join/:category", async (req: any, res) => {
  const category = String(req.params.category || "").trim() as keyof typeof CONTEST_MAP;
  const contestTitles = CONTEST_MAP[category];

  if (!contestTitles) {
    return res.status(400).send("Invalid category");
  }

  // Guard: bots / wrong Content-Type leave req.body undefined
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).send("Invalid request");
  }

  const name         = norm(req.body.name);
  const phone        = normPhone(req.body.phone);
  const address      = norm(req.body.address);
  const city         = norm(req.body.city);
  const state        = norm(req.body.state);
  const pincode      = norm(req.body.pincode);
  const ageCategory  = norm(req.body.age_category);
  const ssrLanguage  = norm(req.body.ssrLanguage);
  const deliveryMode = normalizeDeliveryMode(req.body.delivery_mode);

  const bookTitles    = ([] as any[]).concat(req.body.bookTitle    || []).map((x) => String(x || "").trim());
  const bookLanguages = ([] as any[]).concat(req.body.bookLanguage || []).map((x) => String(x || "").trim());

  // ── Validation ──
  if (!name || name.length < 2)              return res.send("Invalid name");
  if (!/^[6-9]\d{9}$/.test(phone))          return res.send("Invalid phone");
  if (!["0-25", "above-25"].includes(ageCategory))         return res.send("Invalid age category");
  if (!["home_delivery", "temple_pickup", "donate"].includes(deliveryMode)) return res.send("Invalid delivery mode");

  if (deliveryMode === "home_delivery") {
    if (!address || !city || !state || !/^[1-9]\d{5}$/.test(pincode)) {
      return res.send("Complete address required");
    }
  }

  const contestQ = await pool.query(
    `SELECT id, title, price
     FROM contests
     WHERE title = ANY($1::text[])
       AND is_active = true
     ORDER BY title ASC`,
    [contestTitles]
  );

  if (!contestQ.rows.length) {
    return res.send("No contests found");
  }

  const availableBookLanguages = await fetchAvailableBookLanguages();

  if (deliveryMode !== "donate") {
    for (let i = 0; i < contestQ.rows.length; i++) {
      const b = bookTitles[i];
      const l = bookLanguages[i];
      if (!b || !l) return res.send("Select book + language");
      if (!(availableBookLanguages[b] || []).includes(l)) { return res.send("Invalid book-language");}
    }
  }

  await pool.query("BEGIN");

  try {
    // user create/reuse
    let userQ = await pool.query(`SELECT * FROM users WHERE phone=$1 LIMIT 1`, [phone]);
    let user = userQ.rows[0];

    if (!user) {
      const ins = await pool.query(
        `INSERT INTO users (name, phone, role, phone_locked, address, city, state, pincode)
         VALUES ($1,$2,'user',true,$3,$4,$5,$6)
         RETURNING *`,
        [name, phone, address || null, city || null, state || null, pincode || null]
      );
      user = ins.rows[0];
    } else {
      await pool.query(
        `UPDATE users
         SET
           name    = CASE WHEN COALESCE(TRIM(name),    '') = '' AND $1 <> '' THEN $1 ELSE name    END,
           address = CASE WHEN COALESCE(TRIM(address), '') = '' AND $2 <> '' THEN $2 ELSE address END,
           city    = CASE WHEN COALESCE(TRIM(city),    '') = '' AND $3 <> '' THEN $3 ELSE city    END,
           state   = CASE WHEN COALESCE(TRIM(state),   '') = '' AND $4 <> '' THEN $4 ELSE state   END,
           pincode = CASE WHEN COALESCE(TRIM(pincode), '') = '' AND $5 <> '' THEN $5 ELSE pincode END
         WHERE id = $6`,
        [name, address, city, state, pincode, user.id]
      );
    }

    // ── Idempotency: reuse existing pending group if user hits back & resubmits ──
    // If this user already has pending orders for the SAME set of contests
    // created within the last 2 hours, redirect to that existing payment group
    // instead of creating duplicate orders.
    const contestIdList = contestQ.rows.map((c: any) => c.id);
    // Exact match: the payment group must contain ONLY the same contests selected now.
    // Without the total count check, a combo group (4 orders) could be reused when
    // the user selects just Ramayana (1 order) — because it contains a Ramayana row.
    const existingQ = await pool.query(
      `SELECT o.payment_id, COUNT(*) AS matched_cnt
       FROM orders o
       LEFT JOIN shipments sh ON sh.payment_id = o.payment_id
       WHERE o.user_id = $1
         AND o.contest_id = ANY($2::uuid[])
         AND o.payment_status = 'pending'
         AND o.created_at > NOW() - INTERVAL '30 minutes'
         AND (
           ($4 = 'donate'         AND sh.id IS NULL)
           OR COALESCE(LOWER(sh.delivery_mode), '') = LOWER($4)
         )
       GROUP BY o.payment_id
       HAVING
         COUNT(*) = $3
         AND (
           SELECT COUNT(*) FROM orders o2
           WHERE o2.payment_id = o.payment_id
             AND o2.user_id   = $1
         ) = $3
       ORDER BY MAX(o.created_at) DESC
       LIMIT 1`,
      [user.id, contestIdList, contestQ.rows.length, deliveryMode]
    );

    if (existingQ.rows.length > 0) {
      // Reuse the existing pending group — no new orders created
      await pool.query("COMMIT");
      const token = generateToken(user.id);
      setAuthCookie(res, token);
      return res.redirect(
        `/payment/select?paymentId=${encodeURIComponent(existingQ.rows[0].payment_id)}`
      );
    }

    const paymentId = await generateUniqueInternalPaymentId();
    const orderIds:  string[] = [];

    // ── Create orders ──
    for (let i = 0; i < contestQ.rows.length; i++) {
      const c            = contestQ.rows[i];
      const selectedBook = bookTitles[i] || "";
      const rowAmount    = process.env.DIRECT_REG_TEST_PRICE
        ? Number(process.env.DIRECT_REG_TEST_PRICE)
        : Number(c.price || 0);

      const ins = await pool.query(
        `INSERT INTO orders
         (user_id, contest_id, amount, payment_status, payment_id, age_category, created_at, book_option, full_name, book_title)
         VALUES ($1,$2,$3,'pending',$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata'),$6,$7,$8)
         RETURNING id`,
        [
          user.id,
          c.id,
          rowAmount,
          paymentId,
          ageCategory,
          deliveryMode === "donate" ? "donation" : "book",
          name,
          deliveryMode === "home_delivery" ? selectedBook : null,
        ]
      );
      orderIds.push(ins.rows[0].id);
    }

    // ── Create shipment + items ──
    if (deliveryMode !== "donate") {
      const sh =
        deliveryMode === "temple_pickup"
          ? await pool.query(
              `INSERT INTO shipments
               (payment_id, recipient_name, recipient_phone, delivery_mode, status, updated_at)
               VALUES ($1,$2,$3,'temple_pickup','pending',NOW())
               RETURNING id`,
              [paymentId, name, phone]
            )
          : await pool.query(
              `INSERT INTO shipments
               (payment_id, recipient_name, recipient_phone, address, city, state, pincode, delivery_mode, status, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'home_delivery','pending',NOW())
               RETURNING id`,
              [paymentId, name, phone, address, city, state, pincode]
            );

      const shipmentId = sh.rows[0].id;

      for (let i = 0; i < orderIds.length; i++) {
        await pool.query(
          `INSERT INTO shipment_items (shipment_id, order_id, book_title, book_language)
           VALUES ($1,$2,$3,$4)`,
          [shipmentId, orderIds[i], bookTitles[i], bookLanguages[i]]
        );
      }

      // Combo bonus SSR book
      if (category === "combo" && ssrLanguage) {
        await pool.query(
          `INSERT INTO shipment_bonus_items (shipment_id, book_title, book_language, quantity)
           VALUES ($1,$2,$3,1)`,
          [shipmentId, "Science of Self Realization", ssrLanguage]
        );
      }
    }

    // ── All orders + shipments created — redirect to payment selection page ──
    const token = generateToken(user.id);
    await pool.query("COMMIT");
    setAuthCookie(res, token);
    return res.redirect(`/payment/select?paymentId=${encodeURIComponent(paymentId)}`);

  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("directRegistration error:", e);
    return res.send("error");
  }
});

// ─── GET /join/:category ──────────────────────────────────────────────────────
router.get("/join/:category", async (req, res) => {
  const category = String(req.params.category || "").trim() as keyof typeof CONTEST_MAP;

  if (!CONTEST_MAP[category]) {
    return res.status(404).send("Invalid category");
  }

  const availableBookLanguages = await fetchAvailableBookLanguages();
  const selectableBooks = Object.keys(availableBookLanguages)
    .filter((b) => String(b || "").trim() !== "Science of Self Realization")
    .sort((a, b) => a.localeCompare(b));

  return res.render("direct-registration", {
    category,
    categoryLabel:
      category === "ramayana"
        ? "Ramayana Essay Writing Registration"
        : category === "bhagavatam"
        ? "Bhagavatam Essay Writing Registration"
        : category === "krishna"
        ? "Krishna Book Essay Writing Registration"
        : category === "gita"
        ? "Bhagavad Gita Essay Writing Registration"
        : "Combo — All 4 Essay Writing Contests Registration",
    contestTitles: CONTEST_MAP[category],
    phone: String(req.query.phone || ""),
    availableBookLanguages,
    selectableBooks,
    ssrLanguages: availableBookLanguages["Science of Self Realization"] || [],
    error: null,
    old: {},
  });
});

export default router;