import express from "express";
import { pool } from "../config/db";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import { presignGet } from "../utils/s3Get";
import { v4 as uuidv4 } from "uuid";
import { startMultipart, presignPart, completeMultipart, abortMultipart } from "../utils/s3Multipart";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";

const router = express.Router();

const toInt = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const norm = (v: any) => String(v ?? "").trim();
const normLike = (v: any) => `%${norm(v)}%`;

const upload = multer({ dest: path.join(process.cwd(), "tmp") });

function genBatchNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `IP-${y}${m}${day}-${rand}`;
}


function csvEscape(v: any) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(headers: string[], rows: any[][]) {
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n");
}
function sendCsv(res: any, filename: string, headers: string[], rows: any[][]) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(toCsv(headers, rows));
}
const qsOf = (req: any) => {
  const p = new URLSearchParams();
  Object.keys(req.query || {}).forEach((k) => {
    const v = req.query[k];
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((vv) => p.append(k, String(vv)));
    else p.set(k, String(v));
  });
  return p.toString();
};

// --------------------
// OVERVIEW
// --------------------
router.get("/admin", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const usersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
  const ordersAllQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders`);

  const paidOrdersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='paid'`);
  const pendingOrdersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='pending'`);
  const failedOrdersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='failed'`);

  const giftQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='paid' AND book_option='book'`);
  const donateQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='paid' AND book_option='donation'`);

  const revenueQ = await pool.query(`SELECT COALESCE(SUM(amount),0)::int AS total FROM orders WHERE payment_status='paid'`);
  const todayRevenueQ = await pool.query(`
    SELECT COALESCE(SUM(amount),0)::int AS total
    FROM orders
    WHERE payment_status='paid' AND DATE(created_at)=CURRENT_DATE
  `);

  // daily / weekly / monthly series
  const salesDailyQ = await pool.query(`
    SELECT DATE(created_at) AS d, COALESCE(SUM(amount),0)::int AS revenue
    FROM orders
    WHERE payment_status='paid'
      AND created_at >= (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY DATE(created_at)
    ORDER BY d ASC
  `);
  const salesWeeklyQ = await pool.query(`
    SELECT DATE_TRUNC('week', created_at)::date AS w, COALESCE(SUM(amount),0)::int AS revenue
    FROM orders
    WHERE payment_status='paid'
      AND created_at >= (CURRENT_DATE - INTERVAL '84 days')
    GROUP BY DATE_TRUNC('week', created_at)
    ORDER BY w ASC
  `);
  const salesMonthlyQ = await pool.query(`
    SELECT DATE_TRUNC('month', created_at)::date AS m, COALESCE(SUM(amount),0)::int AS revenue
    FROM orders
    WHERE payment_status='paid'
      AND created_at >= (CURRENT_DATE - INTERVAL '365 days')
    GROUP BY DATE_TRUNC('month', created_at)
    ORDER BY m ASC
  `);

  // shipments progress for paid book orders
  const shipStatusQ = await pool.query(`
    SELECT COALESCE(LOWER(sh.status),'pending') AS status, COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE o.payment_status='paid' AND o.book_option='book'
    GROUP BY COALESCE(LOWER(sh.status),'pending')
    ORDER BY c DESC
  `);

  // consider "packed" as ready-to-dispatch bucket; show separately
  const packedQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE o.payment_status='paid' AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'pending')='packed'
  `);

  const dispatchedQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE o.payment_status='paid' AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'') IN ('dispatched','delivered')
  `);

  const pendingDispatchQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE o.payment_status='paid' AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'pending') NOT IN ('dispatched','delivered')
  `);

  // contest registrations + submitted vs not
  const contestStatsQ = await pool.query(`
    SELECT
      c.id, c.title,
      COUNT(o.id)::int AS registrations,
      COUNT(s.id)::int AS submitted
    FROM contests c
    LEFT JOIN orders o ON o.contest_id=c.id AND o.payment_status='paid'
    LEFT JOIN submissions s ON s.order_id=o.id
    GROUP BY c.id, c.title
    ORDER BY registrations DESC, c.title ASC
  `);

  // storage usage (best effort from DB file_size)
  const uploadSizeQ = await pool.query(`
    SELECT
      COALESCE(SUM(COALESCE(file_size,0)),0)::bigint AS bytes,
      COUNT(*)::int AS files,
      COUNT(*) FILTER (WHERE file_size IS NULL)::int AS missing_size
    FROM submissions
  `);

  res.render("admin/admin-dashboard", {
    activeTab: "admin",
    stats: {
      users: usersQ.rows[0].c,
      ordersAll: ordersAllQ.rows[0].c,
      paidOrders: paidOrdersQ.rows[0].c,
      pendingOrders: pendingOrdersQ.rows[0].c,
      failedOrders: failedOrdersQ.rows[0].c,
      gift: giftQ.rows[0].c,
      donate: donateQ.rows[0].c,
      revenue: revenueQ.rows[0].total,
      todayRevenue: todayRevenueQ.rows[0].total,
      packed: packedQ.rows[0].c,
      dispatched: dispatchedQ.rows[0].c,
      pendingDispatch: pendingDispatchQ.rows[0].c,
    },
    series: { daily: salesDailyQ.rows, weekly: salesWeeklyQ.rows, monthly: salesMonthlyQ.rows },
    shipStatus: shipStatusQ.rows,
    contestStats: contestStatsQ.rows.map((r: any) => ({ ...r, not_submitted: Math.max(0, Number(r.registrations) - Number(r.submitted)) })),
    upload: uploadSizeQ.rows[0],
    qs: ""
  });
});

router.get("/admin/export/overview.csv", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const usersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
  const ordersAllQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders`);
  const paidOrdersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM orders WHERE payment_status='paid'`);
  const revenueQ = await pool.query(`SELECT COALESCE(SUM(amount),0)::int AS total FROM orders WHERE payment_status='paid'`);
  const dailyQ = await pool.query(`
    SELECT DATE(created_at) AS d, COALESCE(SUM(amount),0)::int AS revenue
    FROM orders
    WHERE payment_status='paid' AND created_at >= (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY DATE(created_at) ORDER BY d ASC
  `);

  const headers = ["section", "key", "value"];
  const rows: any[][] = [
    ["summary", "users", usersQ.rows[0].c],
    ["summary", "orders_all", ordersAllQ.rows[0].c],
    ["summary", "paid_orders", paidOrdersQ.rows[0].c],
    ["summary", "total_revenue", revenueQ.rows[0].total],
  ];
  for (const r of dailyQ.rows) rows.push(["sales_daily", r.d, r.revenue]);
  return sendCsv(res, "overview_export.csv", headers, rows);
});

// --------------------
// CONTESTS
// --------------------
router.get("/admin/contests", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const contests = await pool.query(`SELECT * FROM contests ORDER BY submission_deadline NULLS LAST, title ASC`);
  res.render("admin/admin-contests", { activeTab: "contests", contests: contests.rows, error: null, success: null, qs: "" });
});

router.get("/admin/contests/export.csv", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const q = await pool.query(`SELECT id, title, description, price, submission_deadline, is_active, image_url FROM contests ORDER BY title ASC`);
  const headers = ["id","title","description","price","submission_deadline","is_active","image_url"];
  const rows = q.rows.map((c: any) => [c.id,c.title,c.description,c.price,c.submission_deadline,c.is_active,c.image_url]);
  return sendCsv(res, "contests.csv", headers, rows);
});

router.post("/admin/contests/create", authMiddleware, adminMiddleware, async (req: any, res) => {
  const title = norm(req.body.title);
  const description = norm(req.body.description);
  const price = toInt(req.body.price, 0);
  const deadline = req.body.submission_deadline ? String(req.body.submission_deadline) : null;
  const imageUrl = norm(req.body.image_url);

  // validation (server side)
  if (!title || title.length < 3) return res.status(400).redirect("/admin/contests?err=title");
  if (!Number.isFinite(price) || price < 0) return res.status(400).redirect("/admin/contests?err=price");
  // allow empty deadline

  await pool.query(
    `INSERT INTO contests (title, description, price, submission_deadline, is_active, image_url)
     VALUES ($1,$2,$3,$4,true,$5)`,
    [title, description || null, price, deadline, imageUrl || null]
  );
  return res.redirect("/admin/contests");
});

router.post("/admin/contests/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const id = norm(req.body.id);
  const title = norm(req.body.title);
  const description = norm(req.body.description);
  const price = toInt(req.body.price, 0);
  const deadline = req.body.submission_deadline ? String(req.body.submission_deadline) : null;
  const imageUrl = norm(req.body.image_url);

  if (!id) return res.redirect("/admin/contests");
  if (!title || title.length < 3) return res.redirect("/admin/contests");
  if (!Number.isFinite(price) || price < 0) return res.redirect("/admin/contests");

  await pool.query(
    `UPDATE contests
     SET title=$1, description=$2, price=$3, submission_deadline=$4, image_url=$5
     WHERE id=$6`,
    [title, description || null, price, deadline, imageUrl || null, id]
  );
  res.redirect("/admin/contests");
});

router.post("/admin/contests/toggle", authMiddleware, adminMiddleware, async (req: any, res) => {
  const id = norm(req.body.id);
  if (!id) return res.redirect("/admin/contests");
  await pool.query(`UPDATE contests SET is_active = NOT is_active WHERE id=$1`, [id]);
  res.redirect("/admin/contests");
});

// --------------------
// ORDERS (filters + facet counts)
// --------------------
function buildOrdersFilter(req: any) {
  const status = norm(req.query.status || "all"); // all|paid|pending|failed
  const bookOption = norm(req.query.book_option || "all"); // all|book|donation
  const contestId = norm(req.query.contest_id || "");
  const userName = norm(req.query.user_name || "");
  const phone = norm(req.query.phone || "");
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");
  const onDate = norm(req.query.on_date || "");

  const where: string[] = [];
  const params: any[] = [];

  if (status !== "all") {
    where.push(`o.payment_status=$${params.length + 1}`);
    params.push(status);
  }
  if (bookOption !== "all") {
    where.push(`o.book_option=$${params.length + 1}`);
    params.push(bookOption);
  }
  if (contestId) {
    where.push(`o.contest_id=$${params.length + 1}`);
    params.push(contestId);
  }
  if (userName) {
    where.push(`u.name ILIKE $${params.length + 1}`);
    params.push(normLike(userName));
  }
  if (phone) {
    // user phone now; later you can OR shipments phone when you add it
    where.push(`u.phone ILIKE $${params.length + 1}`);
    params.push(normLike(phone));
  }

  if (onDate) {
    where.push(`DATE(o.created_at)=DATE($${params.length + 1})`);
    params.push(onDate);
  } else {
    if (dateFrom) {
      where.push(`o.created_at >= $${params.length + 1}::timestamp`);
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push(`o.created_at < ($${params.length + 1}::timestamp + INTERVAL '1 day')`);
      params.push(dateTo);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params, filters: { status, bookOption, contestId, userName, phone, dateFrom, dateTo, onDate } };
}

// facet counts helper: rebuild query excluding one facet
async function facetOrdersCounts(req: any) {
  const base = buildOrdersFilter(req);

  const mk = (overrides: any) => {
    const q2 = { ...req.query, ...overrides };
    const fakeReq = { query: q2 };
    return buildOrdersFilter(fakeReq);
  };

  // counts by status, excluding status filter itself
  const fNoStatus = mk({ status: "all" });
  const statusCountsQ = await pool.query(
    `
    SELECT o.payment_status, COUNT(*)::int AS c
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${fNoStatus.whereSql}
    GROUP BY o.payment_status
    `,
    fNoStatus.params
  );

  // counts by book_option excluding book_option filter itself
  const fNoBook = mk({ book_option: "all" });
  const bookCountsQ = await pool.query(
    `
    SELECT o.book_option, COUNT(*)::int AS c
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${fNoBook.whereSql}
    GROUP BY o.book_option
    `,
    fNoBook.params
  );

  // contest counts excluding contest_id filter itself (limit top 15)
  const fNoContest = mk({ contest_id: "" });
  const contestCountsQ = await pool.query(
    `
    SELECT c.id, c.title, COUNT(*)::int AS c
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${fNoContest.whereSql}
    GROUP BY c.id, c.title
    ORDER BY c DESC, c.title ASC
    LIMIT 15
    `,
    fNoContest.params
  );

  const mapCounts = (rows: any[], key: string) => {
    const m: any = {};
    rows.forEach((r) => (m[String(r[key])] = Number(r.c)));
    return m;
  };

  return {
    status: mapCounts(statusCountsQ.rows, "payment_status"),
    book: mapCounts(bookCountsQ.rows, "book_option"),
    contests: contestCountsQ.rows,
  };
}

router.get("/admin/orders", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params, filters } = buildOrdersFilter(req);

  const listQ = await pool.query(
    `
    SELECT
      o.id, o.amount, o.payment_status, o.book_option, o.created_at,
      o.book_title, o.full_name, o.dob,
      u.id AS user_id, u.name AS user_name, u.email, u.phone,
      c.id AS contest_id, c.title AS contest_title
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${whereSql}
    ORDER BY o.created_at DESC
    LIMIT 500
    `,
    params
  );

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${whereSql}
    `,
    params
  );

  const contestsQ = await pool.query(`SELECT id, title FROM contests ORDER BY title ASC`);
  const facets = await facetOrdersCounts(req);

  res.render("admin/admin-orders", {
    activeTab: "orders",
    orders: listQ.rows,
    totalCount: countQ.rows[0].c,
    contests: contestsQ.rows,
    filters,
    facets,
    qs: qsOf(req),
  });
});

router.get("/admin/orders/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params } = buildOrdersFilter(req);

  const q = await pool.query(
    `
    SELECT
      o.id, o.created_at, o.amount, o.payment_status, o.book_option, o.payment_id,
      o.book_title, o.full_name, o.dob,
      u.id AS user_id, u.name AS user_name, u.email, u.phone,
      c.title AS contest_title
    FROM orders o
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${whereSql}
    ORDER BY o.created_at DESC
    LIMIT 5000
    `,
    params
  );

  const headers = [
    "order_id","created_at","amount","payment_status","book_option","payment_id",
    "book_title","full_name","dob",
    "user_id","user_name","email","phone","contest_title"
  ];
  const rows = q.rows.map((r: any) => [
    r.id,r.created_at,r.amount,r.payment_status,r.book_option,r.payment_id,
    r.book_title,r.full_name,r.dob,
    r.user_id,r.user_name,r.email,r.phone,r.contest_title
  ]);

  return sendCsv(res, "orders_export.csv", headers, rows);
});

router.get(
  "/admin/india-post/export/:batchNo",
  authMiddleware,
  adminMiddleware,
  async (req: any, res) => {
    try {
      const batchNo = (req.params.batchNo || "").trim();
      if (!batchNo) {
        return res.status(400).send("Missing batch number");
      }

      const q = await pool.query(
        `
        SELECT *
        FROM india_post_bookings
        WHERE batch_no = $1
        ORDER BY serial_number ASC, created_at ASC
        `,
        [batchNo]
      );

      if (!q.rows.length) {
        return res.status(404).send("Batch not found");
      }

      // -------- ArticleDetails Sheet --------
      const articleDetails = q.rows.map((r: any) => ({
        "SERIAL NUMBER": r.serial_number,
        "BARCODE NO": r.barcode_no || "",
        "PHYSICAL WEIGHT": Number(r.physical_weight || 0.8),

        "SENDER NAME": r.sender_name || "",
        "SENDER COMPANY NAME": r.sender_company || "",
        "SENDER ADD LINE 1": r.sender_add_line1 || "",
        "SENDER ADD LINE 2": r.sender_add_line2 || "",
        "SENDER ADD LINE 3": r.sender_add_line3 || "",
        "SENDER CITY": r.sender_city || "",
        "SENDER STATE": r.sender_state || "",
        "SENDER PINCODE": r.sender_pincode || "",
        "SENDER EMAILID": r.sender_emailid || "",
        "SENDER ALT CONTACT NO": r.sender_alt_contact || "",
        "SENDER MOBILE NO": r.sender_mobile_no || "",

        "RECEIVER NAME": r.receiver_name || "",
        "RECEIVER COMPANY NAME": r.receiver_company || "",
        "RECEIVER ADD LINE 1": r.receiver_add_line1 || "",
        "RECEIVER ADD LINE 2": r.receiver_add_line2 || "",
        "RECEIVER ADD LINE 3": r.receiver_add_line3 || "",
        "RECEIVER CITY": r.receiver_city || "",
        "RECEIVER STATE": r.receiver_state || "",
        "RECEIVER PINCODE": r.receiver_pincode || "",
        "RECEIVER EMAILID": r.receiver_emailid || "",
        "RECEIVER ALT CONTACT NO": r.receiver_alt_contact || "",
        "RECEIVER MOBILE NO": r.receiver_mobile_no || "",

        "SHAPE OF ARTICLE": r.shape_of_article || "",
        "LENGTH(CM)": r.length_cm || "",
        "BREADTH/DIAMETER(CM)": r.breadth_cm || "",
        "HEIGHT(CM)": r.height_cm || "",
        "PRIORITY FLAG": r.priority_flag || "",

        "ALT ADDRESS FLAG": r.alt_address_flag || "N",
        "PICKUP ADDRESS FLAG": r.pickup_address_flag || "N",
        "PICKUP ADDRESS SERIAL NO": r.pickup_address_serial_no || "",
        "ALT ADDRESS SERIAL NO": r.alt_address_serial_no || "",
        "DROP OFF PINCODE": r.drop_off_pincode || "",
        "ACK": r.ack || "N"
      }));

      // -------- Required Empty Sheets --------
      const pickupAddress = [{
        addressee_name: "",
        company_name: "",
        address_line1: "",
        address_line2: "",
        address_line3: "",
        city: "",
        state: "",
        pincode: "",
        email_id: "",
        alt_contact_no: "",
        mobile_no: "",
        pickup_schedule_slot: "",
        pickup_schedule_date: ""
      }];

      const altAddress = [{
        "SERIAL NO": "",
        "ADDRESSEE NAME": "",
        "COMPANY NAME": "",
        "ADDRESS LINE 1": "",
        "ADDRESS LINE 2": "",
        "ADDRESS LINE 3": "",
        "CITY": "",
        "STATE": "",
        "PINCODE": "",
        "EMAIL ID": "",
        "ALT CONTACT NO": "",
        "MOBILE NO": ""
      }];

      const info = [{
        note: `India Post Batch: ${batchNo}`
      }];

      // -------- Create Workbook --------
      const wb = XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(articleDetails),
        "ArticleDetails"
      );

      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(pickupAddress),
        "PickupAddress"
      );

      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(altAddress),
        "AltAddress"
      );

      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(info),
        "Information"
      );

      const fileName = `india_post_${batchNo}.xlsx`;
      const tmpPath = path.join(process.cwd(), "tmp", fileName);

      XLSX.writeFile(wb, tmpPath);

      // mark exported
      await pool.query(
        `
        UPDATE india_post_bookings
        SET export_status='exported', updated_at=NOW()
        WHERE batch_no=$1
        `,
        [batchNo]
      );

      return res.download(tmpPath, fileName, () => {
        fs.unlink(tmpPath, () => {});
      });

    } catch (err) {
      console.error("India Post export error:", err);
      return res.status(500).send("Failed to export India Post Excel");
    }
  }
);

// --------------------
// SUBMISSIONS (filters + csv + download rename)
// --------------------
function buildSubmissionsFilter(req: any) {
  const contestId = norm(req.query.contest_id || "");
  const userName = norm(req.query.user_name || "");
  const email = norm(req.query.email || "");
  const locked = norm(req.query.locked || "all"); // all|yes|no
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");

  const where: string[] = [];
  const params: any[] = [];

  if (contestId) { where.push(`c.id=$${params.length + 1}`); params.push(contestId); }
  if (userName) { where.push(`u.name ILIKE $${params.length + 1}`); params.push(normLike(userName)); }
  if (email) { where.push(`u.email ILIKE $${params.length + 1}`); params.push(normLike(email)); }

  if (locked !== "all") {
    where.push(`s.is_locked = $${params.length + 1}`);
    params.push(locked === "yes");
  }

  if (dateFrom) { where.push(`s.uploaded_at >= $${params.length + 1}::timestamp`); params.push(dateFrom); }
  if (dateTo) { where.push(`s.uploaded_at < ($${params.length + 1}::timestamp + INTERVAL '1 day')`); params.push(dateTo); }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params, filters: { contestId, userName, email, locked, dateFrom, dateTo } };
}

router.get("/admin/submissions", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params, filters } = buildSubmissionsFilter(req);

  const q = await pool.query(
    `
    SELECT
      s.id, s.order_id, s.original_name, s.content_type, s.uploaded_at, s.is_locked, s.file_size,
      u.id AS user_id, u.name AS user_name, u.email,
      c.id AS contest_id, c.title AS contest_title
    FROM submissions s
    JOIN orders o ON o.id=s.order_id
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${whereSql}
    ORDER BY s.uploaded_at DESC NULLS LAST
    LIMIT 500
    `,
    params
  );

  const contestsQ = await pool.query(`SELECT id, title FROM contests ORDER BY title ASC`);

  res.render("admin/admin-submissions", {
    activeTab: "submissions",
    items: q.rows,
    contests: contestsQ.rows,
    filters,
    qs: qsOf(req),
  });
});

router.get("/admin/submissions/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params } = buildSubmissionsFilter(req);

  const q = await pool.query(
    `
    SELECT
      s.id, s.order_id, s.original_name, s.content_type, s.uploaded_at, s.is_locked, s.file_size,
      u.id AS user_id, u.name AS user_name, u.email, u.phone,
      c.title AS contest_title
    FROM submissions s
    JOIN orders o ON o.id=s.order_id
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    ${whereSql}
    ORDER BY s.uploaded_at DESC NULLS LAST
    LIMIT 5000
    `,
    params
  );

  const headers = ["submission_id","order_id","uploaded_at","is_locked","file_size","original_name","content_type","user_id","user_name","email","phone","contest_title"];
  const rows = q.rows.map((r: any) => [r.id,r.order_id,r.uploaded_at,r.is_locked,r.file_size,r.original_name,r.content_type,r.user_id,r.user_name,r.email,r.phone,r.contest_title]);

  return sendCsv(res, "submissions_export.csv", headers, rows);
});

router.post("/admin/submissions/toggle-lock", authMiddleware, adminMiddleware, async (req: any, res) => {
  const submissionId = norm(req.body.submissionId);
  if (!submissionId) return res.redirect("/admin/submissions");
  await pool.query(`UPDATE submissions SET is_locked = NOT is_locked WHERE id=$1`, [submissionId]);
  res.redirect("/admin/submissions");
});

router.get("/admin/submissions/download", authMiddleware, adminMiddleware, async (req: any, res) => {
  const submissionId = String(req.query.submissionId || "").trim();
  if (!submissionId) return res.status(400).send("Missing submissionId");

  const q = await pool.query(
    `
    SELECT
      s.s3_key, s.original_name,
      u.id AS user_id,
      c.title AS contest_title
    FROM submissions s
    JOIN orders o ON o.id=s.order_id
    JOIN users u ON u.id=o.user_id
    JOIN contests c ON c.id=o.contest_id
    WHERE s.id=$1
    LIMIT 1
    `,
    [submissionId]
  );

  if (q.rows.length === 0) return res.status(404).send("Not found");
  const row = q.rows[0];
  if (!row.s3_key) return res.status(404).send("No file");

  const safeContest = String(row.contest_title || "contest").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const safeOrig = String(row.original_name || "file").replace(/[\/\\]/g, "_");
  const downloadName = `${row.user_id}_${safeContest}_${safeOrig}`;

  const url = await presignGet(row.s3_key, downloadName);
  return res.redirect(url);
});

// --------------------
// SHIPMENTS (filters + missing tracking + status counts)
// --------------------





function buildShipmentsFilter(req: any) {
  const contestId = norm(req.query.contest_id || "");
  const userName = norm(req.query.user_name || "");
  const status = norm(req.query.status || "all");
  const missingTracking = norm(req.query.missing_tracking || "0");
  const ipStatus = norm(req.query.ip_status || "all");

  const where: string[] = [`o.payment_status='paid'`, `o.book_option='book'`];
  const params: any[] = [];

  if (contestId) {
    where.push(`o.contest_id=$${params.length + 1}`);
    params.push(contestId);
  }
  if (userName) {
    where.push(`u.name ILIKE $${params.length + 1}`);
    params.push(normLike(userName));
  }
  if (status !== "all") {
    where.push(`COALESCE(LOWER(sh.status),'pending') = $${params.length + 1}`);
    params.push(status.toLowerCase());
  }
  if (missingTracking === "1") {
    where.push(`(sh.tracking_id IS NULL OR sh.tracking_id='')`);
  }
  if (ipStatus !== "all") {
    where.push(`
      EXISTS (
        SELECT 1
        FROM india_post_bookings ipb
        WHERE ipb.shipment_id = sh.id
          AND COALESCE(LOWER(ipb.booking_status),'pending') = $${params.length + 1}
      )
    `);
    params.push(ipStatus.toLowerCase());
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  return { whereSql, params, filters: { contestId, userName, status, missingTracking, ipStatus } };
}

router.get("/admin/shipments", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params, filters } = buildShipmentsFilter(req);

  const q = await pool.query(
    `
    SELECT
      sh.id AS shipment_id,
      sh.payment_id,
      u.id AS user_id,
      u.name AS user_name,
      u.email,
      u.phone,
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles,
      STRING_AGG(DISTINCT COALESCE(si.book_title, ''), ', ' ORDER BY COALESCE(si.book_title, '')) AS book_titles,
      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.status,
      sh.updated_at,
      MAX(ipb.batch_no) AS batch_no,
      MAX(ipb.booking_status) AS ip_booking_status
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id
    LEFT JOIN india_post_bookings ipb ON ipb.shipment_id = sh.id
    ${whereSql}
    GROUP BY
      sh.id, sh.payment_id, u.id, u.name, u.email, u.phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at
    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
    LIMIT 500
    `,
    params
  );

  const fNoStatus = buildShipmentsFilter({ query: { ...req.query, status: "all" } });
  const statusCounts = await pool.query(
    `
    SELECT COALESCE(LOWER(sh.status),'pending') AS status, COUNT(DISTINCT sh.id)::int AS c
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id
    ${fNoStatus.whereSql}
    GROUP BY COALESCE(LOWER(sh.status),'pending')
    `,
    fNoStatus.params
  );

  const contestsQ = await pool.query(`SELECT id, title FROM contests ORDER BY title ASC`);

  res.render("admin/admin-shipments", {
    activeTab: "shipments",
    items: q.rows,
    contests: contestsQ.rows,
    filters,
    statusFacets: statusCounts.rows,
    qs: qsOf(req),
    batchCreated: norm(req.query.batchCreated || ""),
    imported: norm(req.query.imported || ""),
    errorMsg: norm(req.query.errorMsg || ""),
  });
});



router.get("/admin/shipments/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params } = buildShipmentsFilter(req);

  const q = await pool.query(
    `
    SELECT
      sh.id AS shipment_id,
      sh.payment_id,
      u.id AS user_id,
      u.name AS user_name,
      u.email,
      u.phone,
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles,
      STRING_AGG(DISTINCT COALESCE(si.book_title, ''), ', ' ORDER BY COALESCE(si.book_title, '')) AS book_titles,
      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.status,
      sh.updated_at,
      MAX(ipb.batch_no) AS batch_no,
      MAX(ipb.booking_status) AS ip_booking_status
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id
    LEFT JOIN india_post_bookings ipb ON ipb.shipment_id = sh.id
    ${whereSql}
    GROUP BY
      sh.id, sh.payment_id, u.id, u.name, u.email, u.phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at
    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
    `,
    params
  );

  const headers = [
    "shipment_id","payment_id","user_id","user_name","email","phone",
    "contest_titles","book_titles","address","city","state","pincode",
    "tracking_id","courier_mode","status","batch_no","ip_booking_status","updated_at"
  ];

  const rows = q.rows.map((r: any) => [
    r.shipment_id, r.payment_id, r.user_id, r.user_name, r.email, r.phone,
    r.contest_titles, r.book_titles, r.address, r.city, r.state, r.pincode,
    r.tracking_id, r.courier_mode, r.status, r.batch_no, r.ip_booking_status, r.updated_at
  ]);

  return sendCsv(res, "shipments_export.csv", headers, rows);
});


router.post("/admin/shipments/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const shipmentId = norm(req.body.shipmentId);
  const trackingId = norm(req.body.tracking_id);
  const courierMode = norm(req.body.courier_mode);
  const status = norm(req.body.status || "pending").toLowerCase();

  if (!shipmentId) return res.redirect("/admin/shipments");

  await pool.query(
    `UPDATE shipments
     SET tracking_id=$1, courier_mode=$2, status=$3, updated_at=NOW()
     WHERE id=$4`,
    [trackingId || null, courierMode || null, status, shipmentId]
  );

  res.redirect("/admin/shipments");
});

router.post("/admin/india-post/create-batch", authMiddleware, adminMiddleware, async (req: any, res) => {
  const shipmentIdsRaw = req.body.shipment_ids;
  const shipmentIds = Array.isArray(shipmentIdsRaw)
    ? shipmentIdsRaw.map((x: any) => norm(x)).filter(Boolean)
    : shipmentIdsRaw ? [norm(shipmentIdsRaw)] : [];

  if (!shipmentIds.length) {
    return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Please select at least one shipment."));
  }

  const batchNo = genBatchNo();

  const senderName = process.env.IP_SENDER_NAME || "ISKCON Tirupati";
  const senderAdd1 = process.env.IP_SENDER_ADD1 || "Tirupati";
  const senderAdd2 = process.env.IP_SENDER_ADD2 || "";
  const senderCity = process.env.IP_SENDER_CITY || "Tirupati";
  const senderState = process.env.IP_SENDER_STATE || "Andhra Pradesh";
  const senderPincode = process.env.IP_SENDER_PINCODE || "";
  const senderEmail = process.env.IP_SENDER_EMAIL || "";
  const senderAlt = process.env.IP_SENDER_ALT_CONTACT || "";
  const senderMobile = process.env.IP_SENDER_MOBILE || "";
  const defaultWeight = Number(process.env.IP_DEFAULT_WEIGHT_KG || "0.800");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let serial = 1;

    for (const shipmentId of shipmentIds) {
      const exists = await client.query(
        `SELECT 1 FROM india_post_bookings WHERE shipment_id=$1 LIMIT 1`,
        [shipmentId]
      );
      if (exists.rows.length) continue;

      const rowsQ = await client.query(
        `
        SELECT
          sh.id AS shipment_id,
          sh.address,
          sh.city,
          sh.state,
          sh.pincode,
          sh.payment_id,
          o.id AS order_id,
          u.id AS user_id,
          COALESCE(o.full_name, u.name) AS receiver_name,
          u.email AS receiver_email,
          u.phone AS receiver_mobile
        FROM shipments sh
        JOIN shipment_items si ON si.shipment_id = sh.id
        JOIN orders o ON o.id = si.order_id
        JOIN users u ON u.id = o.user_id
        WHERE sh.id = $1
        ORDER BY o.created_at ASC
        LIMIT 1
        `,
        [shipmentId]
      );

      if (!rowsQ.rows.length) continue;

      const r = rowsQ.rows[0];

      await client.query(
        `
        INSERT INTO india_post_bookings (
          shipment_id, order_id, user_id, batch_no, serial_number,
          physical_weight,
          sender_name, sender_add_line1, sender_add_line2, sender_city, sender_state, sender_pincode,
          sender_emailid, sender_alt_contact, sender_mobile_no,
          receiver_name, receiver_add_line1, receiver_city, receiver_state, receiver_pincode,
          receiver_emailid, receiver_mobile_no,
          alt_address_flag, pickup_address_flag, drop_off_pincode, ack,
          export_status, booking_status
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,
          $7,$8,$9,$10,$11,$12,
          $13,$14,$15,
          $16,$17,$18,$19,$20,
          $21,$22,
          'N','N',$23,'N',
          'ready','pending'
        )
        `,
        [
          r.shipment_id,
          r.order_id,
          r.user_id,
          batchNo,
          serial++,
          defaultWeight,
          senderName,
          senderAdd1,
          senderAdd2 || null,
          senderCity,
          senderState,
          senderPincode,
          senderEmail || null,
          senderAlt || null,
          senderMobile || null,
          r.receiver_name || "Receiver",
          r.address || "",
          r.city || "",
          r.state || "",
          r.pincode || "",
          r.receiver_email || null,
          r.receiver_mobile || null,
          r.pincode || ""
        ]
      );
    }

    await client.query("COMMIT");
    return res.redirect("/admin/shipments?batchCreated=" + encodeURIComponent(batchNo));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("india-post create-batch error:", e);
    return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Failed to create India Post batch."));
  } finally {
    client.release();
  }
});

router.post(
  "/admin/india-post/import-result",
  authMiddleware,
  adminMiddleware,
  upload.single("result_file"),
  async (req: any, res) => {
    try {
      if (!req.file?.path) {
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Please choose a result Excel file."));
      }

      const wb = XLSX.readFile(req.file.path);
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      let updated = 0;

      for (const row of rows) {
        const serialNumber = Number(
          row["SERIAL NUMBER"] ||
          row["SERIAL NO"] ||
          row["Serial Number"] ||
          0
        );

        const barcodeNo =
          String(
            row["BARCODE NO"] ||
            row["BARCODE"] ||
            row["ARTICLE NUMBER"] ||
            row["ARTICLE NO"] ||
            row["TRACKING NUMBER"] ||
            ""
          ).trim();

        if (!serialNumber) continue;

        const ipbQ = await pool.query(
          `
          SELECT id, shipment_id, batch_no
          FROM india_post_bookings
          WHERE serial_number=$1
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [serialNumber]
        );

        if (!ipbQ.rows.length) continue;

        const ipb = ipbQ.rows[0];
        const trackingNo = barcodeNo || null;
        const trackingUrl = trackingNo
          ? `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?consignment=${encodeURIComponent(trackingNo)}`
          : null;

        await pool.query(
          `
          UPDATE india_post_bookings
          SET
            barcode_no = COALESCE($1, barcode_no),
            tracking_no = COALESCE($2, tracking_no),
            tracking_url = COALESCE($3, tracking_url),
            booking_status = CASE WHEN $2 IS NOT NULL AND $2 <> '' THEN 'booked' ELSE booking_status END,
            booked_at = CASE WHEN $2 IS NOT NULL AND $2 <> '' THEN NOW() ELSE booked_at END,
            result_row = $4::jsonb,
            updated_at = NOW()
          WHERE id = $5
          `,
          [
            barcodeNo || null,
            trackingNo,
            trackingUrl,
            JSON.stringify(row),
            ipb.id
          ]
        );

        if (trackingNo) {
          await pool.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = 'india_post',
              status = CASE
                WHEN COALESCE(status,'') IN ('delivered') THEN status
                ELSE 'dispatched'
              END,
              updated_at = NOW()
            WHERE id = $2
            `,
            [trackingNo, ipb.shipment_id]
          );
        }

        updated++;
      }

      fs.unlink(req.file.path, () => {});
      return res.redirect("/admin/shipments?imported=" + encodeURIComponent(String(updated)));
    } catch (e) {
      console.error("india-post import-result error:", e);
      return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Failed to import result file."));
    }
  }
);


// --------------------
// USERS 360 (mega view)
// --------------------

// Search page
router.get("/admin/user360", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const live = norm(req.query.live || "0"); // 1/0

  const users = q
    ? await pool.query(
        `
        SELECT id, name, email, phone, role, created_at, address, city, state, pincode
        FROM users
        WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR address ILIKE $1 OR pincode ILIKE $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [normLike(q)]
      )
    : { rows: [] as any[] };

  res.render("admin/admin-user360", { activeTab: "user360", q, live, users: users.rows, qs: qsOf(req) });
});

// JSON search (for live mode)
router.get("/admin/user360/search", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  if (!q || q.length < 2) return res.json({ items: [] });

  const users = await pool.query(
    `
    SELECT id, name, email, phone, role
    FROM users
    WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR address ILIKE $1 OR pincode ILIKE $1
    ORDER BY created_at DESC
    LIMIT 20
    `,
    [normLike(q)]
  );

  res.json({ items: users.rows });
});

// Mega user detail page
router.get("/admin/user360/:userId", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);

  const u = await pool.query(
    `SELECT id, name, email, phone, role, created_at, phone_locked, address, city, state, pincode
     FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );
  if (!u.rows.length) return res.status(404).send("User not found");

  const orders = await pool.query(
    `
    SELECT o.*, c.title AS contest_title
    FROM orders o
    JOIN contests c ON c.id=o.contest_id
    WHERE o.user_id=$1
    ORDER BY o.created_at DESC
    LIMIT 200
    `,
    [userId]
  );

  const shipments = await pool.query(
    `
    SELECT o.id AS order_id, sh.*
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE o.user_id=$1
    ORDER BY o.created_at DESC
    LIMIT 200
    `,
    [userId]
  );

  const submissions = await pool.query(
    `
    SELECT s.*, o.contest_id, c.title AS contest_title
    FROM submissions s
    JOIN orders o ON o.id=s.order_id
    JOIN contests c ON c.id=o.contest_id
    WHERE o.user_id=$1
    ORDER BY s.uploaded_at DESC NULLS LAST
    LIMIT 200
    `,
    [userId]
  );

  const feedback = await pool.query(
    `
    SELECT *
    FROM feedback_tickets
    WHERE user_id=$1
    ORDER BY created_at DESC
    LIMIT 200
    `,
    [userId]
  );

  res.render("admin/admin-user360-detail", {
    activeTab: "user360",
    user: u.rows[0],
    orders: orders.rows,
    shipments: shipments.rows,
    submissions: submissions.rows,
    feedback: feedback.rows,
  });
});

// Update user (admin override)
router.post("/admin/user360/:userId/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);

  const name = norm(req.body.name);
  const phone = norm(req.body.phone);
  const address = norm(req.body.address);
  const city = norm(req.body.city);
  const state = norm(req.body.state);
  const pincode = norm(req.body.pincode);
  const role = norm(req.body.role || "user");

  if (!["user", "admin"].includes(role)) return res.redirect(`/admin/user360/${userId}`);

  await pool.query(
    `
    UPDATE users
    SET name=$1, phone=$2, address=$3, city=$4, state=$5, pincode=$6, role=$7
    WHERE id=$8
    `,
    [name || null, phone || null, address || null, city || null, state || null, pincode || null, role, userId]
  );

  res.redirect(`/admin/user360/${userId}`);
});

// --------------------
// USERS
// --------------------
router.get("/admin/users", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const where: string[] = [];
  const params: any[] = [];

  if (q) {
    where.push(`(name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`);
    params.push(normLike(q));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const users = await pool.query(
    `SELECT id, name, email, phone, role, created_at FROM users ${whereSql} ORDER BY created_at DESC LIMIT 200`,
    params
  );

  res.render("admin/admin-users", { activeTab: "users", users: users.rows, q, qs: qsOf(req) });
});

router.get("/admin/users/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const qtxt = norm(req.query.q || "");
  const where: string[] = [];
  const params: any[] = [];

  if (qtxt) {
    where.push(`(name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`);
    params.push(normLike(qtxt));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const q = await pool.query(
    `SELECT id, name, email, phone, role, created_at FROM users ${whereSql} ORDER BY created_at DESC LIMIT 5000`,
    params
  );

  const headers = ["id","name","email","phone","role","created_at"];
  const rows = q.rows.map((u: any) => [u.id, u.name, u.email, u.phone, u.role, u.created_at]);

  return sendCsv(res, "users_export.csv", headers, rows);
});

router.post("/admin/users/role", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.body.userId);
  const role = norm(req.body.role || "user");
  if (!userId) return res.redirect("/admin/users");
  if (!["user", "admin"].includes(role)) return res.redirect("/admin/users");

  await pool.query(`UPDATE users SET role=$1 WHERE id=$2`, [role, userId]);
  res.redirect("/admin/users");
});

// --------------------
// FEEDBACK (admin view)
// --------------------
router.get("/admin/feedback", authMiddleware, adminMiddleware, async (req: any, res) => {
  const status = norm(req.query.status || "open"); // open|closed|all
  const where: string[] = [];
  const params: any[] = [];

  if (status !== "all") {
    where.push(`f.status=$${params.length + 1}`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const q = await pool.query(
    `
    SELECT
      f.id, f.user_id, f.message, f.status, f.created_at, f.closed_at,
      u.name AS user_name, u.email, u.phone
    FROM feedback_tickets f
    LEFT JOIN users u ON u.id=f.user_id
    ${whereSql}
    ORDER BY f.created_at DESC
    LIMIT 300
    `,
    params
  );

  res.render("admin/admin-feedback", { activeTab: "feedback", items: q.rows, status, qs: qsOf(req) });
});

router.get("/admin/feedback/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const status = norm(req.query.status || "open");
  const where: string[] = [];
  const params: any[] = [];
  if (status !== "all") { where.push(`f.status=$1`); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const q = await pool.query(
    `
    SELECT
      f.id, f.user_id, f.message, f.status, f.created_at, f.closed_at,
      u.name AS user_name, u.email, u.phone
    FROM feedback_tickets f
    LEFT JOIN users u ON u.id=f.user_id
    ${whereSql}
    ORDER BY f.created_at DESC
    LIMIT 5000
    `,
    params
  );

  const headers = ["ticket_id","user_id","user_name","email","phone","message","status","created_at","closed_at"];
  const rows = q.rows.map((t: any) => [t.id,t.user_id,t.user_name,t.email,t.phone,t.message,t.status,t.created_at,t.closed_at]);
  return sendCsv(res, "feedback_export.csv", headers, rows);
});

router.post("/admin/feedback/close", authMiddleware, adminMiddleware, async (req: any, res) => {
  const id = norm(req.body.id);
  if (!id) return res.redirect("/admin/feedback");

  await pool.query(
    `UPDATE feedback_tickets SET status='closed', closed_at=NOW() WHERE id=$1`,
    [id]
  );
  res.redirect("/admin/feedback");
});


// --------------------
// ADMIN UPLOAD ON BEHALF (SUBMISSIONS)
// --------------------
const ADMIN_ALLOWED_EXT = new Set([
  "pdf","doc","docx","mp3","wav","aac","m4a","ogg","mp4","m4v","mov","webm","mkv"
]);

const ADMIN_ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/mpeg","audio/mp3","audio/wav","audio/x-wav","audio/aac","audio/mp4","audio/m4a","audio/ogg",
  "application/ogg",
  "video/mp4","video/m4v","video/x-m4v","video/quicktime","video/webm","video/x-matroska",
  "application/octet-stream"
]);

const ADMIN_MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024);

function getExt(fileName: string) {
  const parts = (fileName || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop()! : "";
}

function isAllowed(contentType: string, fileName: string) {
  const ct = (contentType || "").toLowerCase().trim();
  const ext = getExt(fileName);
  if (ADMIN_ALLOWED_MIME.has(ct)) return true;
  if (ADMIN_ALLOWED_EXT.has(ext)) return true;
  return false;
}

async function adminGate(orderId: string) {
  const q = await pool.query(
    `
    SELECT
      o.id, o.user_id,
      c.submission_deadline,
      CASE
        WHEN c.submission_deadline IS NULL THEN false
        WHEN (NOW() AT TIME ZONE 'Asia/Kolkata') > c.submission_deadline THEN true
        ELSE false
      END AS deadline_passed
    FROM orders o
    JOIN contests c ON c.id=o.contest_id
    WHERE o.id=$1 AND o.payment_status='paid'
    LIMIT 1
    `,
    [orderId]
  );

  if (!q.rows.length) return { ok:false, code:403, msg:"Invalid / unpaid order." };
  if (q.rows[0].deadline_passed) return { ok:false, code:403, msg:"Submission deadline has passed." };
  return { ok:true, userId: q.rows[0].user_id as string };
}

function keyBelongs(orderId: string, userId: string, key: string) {
  const prefix = `submissions/2026/user-${userId}/order-${orderId}/`;
  return typeof key === "string" && key.startsWith(prefix);
}

router.post("/admin/submissions/upload/start", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { orderId, fileName, contentType, fileSize } = req.body;
  if (!orderId || !fileName || !contentType || !fileSize) return res.status(400).json({ error:"Missing fields" });

  const gate = await adminGate(String(orderId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0 || size > ADMIN_MAX_BYTES) {
    return res.status(400).json({ error:`Max file size is ${process.env.MAX_UPLOAD_MB || 500}MB` });
  }
  if (!isAllowed(String(contentType), String(fileName))) {
    return res.status(400).json({ error:"File type not allowed." });
  }

  const existing = await pool.query(`SELECT id, is_locked FROM submissions WHERE order_id=$1`, [orderId]);
  if (existing.rows.length > 0 && existing.rows[0].is_locked) {
    return res.status(403).json({ error:"Submission locked" });
  }

  const userId = gate.userId!;
  const ext = getExt(String(fileName)) || "bin";
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = `submissions/2026/user-${userId}/order-${orderId}/${uuidv4()}.${safeExt}`;

  const { uploadId } = await startMultipart(key, String(contentType));
  return res.json({ key, uploadId, userId });
});

router.post("/admin/submissions/upload/presign-parts", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { orderId, userId, key, uploadId, partNumbers } = req.body;
  if (!orderId || !userId || !key || !uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return res.status(400).json({ error:"Missing fields" });
  }

  const gate = await adminGate(String(orderId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (String(gate.userId) !== String(userId)) return res.status(403).json({ error:"User mismatch" });
  if (!keyBelongs(String(orderId), String(userId), String(key))) return res.status(403).json({ error:"Invalid upload key" });

  const urls = await Promise.all(
    partNumbers.map(async (pn: number) => ({
      partNumber: pn,
      url: await presignPart(String(key), String(uploadId), Number(pn))
    }))
  );

  return res.json({ urls });
});

router.post("/admin/submissions/upload/complete", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { orderId, userId, key, uploadId, parts, contentType, originalName, fileSize } = req.body;
  if (!orderId || !userId || !key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error:"Missing fields" });
  }

  const gate = await adminGate(String(orderId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (String(gate.userId) !== String(userId)) return res.status(403).json({ error:"User mismatch" });
  if (!keyBelongs(String(orderId), String(userId), String(key))) return res.status(403).json({ error:"Invalid upload key" });

  const existing = await pool.query(`SELECT id, is_locked FROM submissions WHERE order_id=$1`, [orderId]);
  if (existing.rows.length > 0 && existing.rows[0].is_locked) {
    return res.status(403).json({ error:"Submission locked" });
  }

  await completeMultipart(String(key), String(uploadId), parts);

  const publicUrl = `${process.env.S3_PUBLIC_BASE}/${key}`;

  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO submissions (order_id, file_url, s3_key, content_type, original_name, file_size, uploaded_at, last_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,(NOW() AT TIME ZONE 'Asia/Kolkata'),(NOW() AT TIME ZONE 'Asia/Kolkata'))`,
      [orderId, publicUrl, key, contentType || null, originalName || null, Number(fileSize) || null]
    );
  } else {
    await pool.query(
      `UPDATE submissions
       SET file_url=$1, s3_key=$2, content_type=$3, original_name=$4, file_size=$5,
           uploaded_at=(NOW() AT TIME ZONE 'Asia/Kolkata'),
           last_updated_at=(NOW() AT TIME ZONE 'Asia/Kolkata')
       WHERE order_id=$6`,
      [publicUrl, key, contentType || null, originalName || null, Number(fileSize) || null, orderId]
    );
  }

  return res.json({ ok:true });
});

router.post("/admin/submissions/upload/abort", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { orderId, userId, key, uploadId } = req.body;
  if (!orderId || !userId || !key || !uploadId) return res.status(400).json({ error:"Missing fields" });

  const gate = await adminGate(String(orderId));
  if (!gate.ok) return res.status(gate.code!).json({ error: gate.msg });

  if (String(gate.userId) !== String(userId)) return res.status(403).json({ error:"User mismatch" });
  if (!keyBelongs(String(orderId), String(userId), String(key))) return res.status(403).json({ error:"Invalid upload key" });

  await abortMultipart(String(key), String(uploadId));
  return res.json({ ok:true });
});
export default router;
