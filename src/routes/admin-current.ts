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
import https from "https";
//import {  sendContestRegistrationMessageOnce, sendShipmentDispatchMessageOnce,} from "../services/contestConfirmation";
import {  sendContestRegistrationMessageOnce,} from "../services/contestConfirmation";
import { hashPassword } from "../utils/hash";

const router = express.Router();

const toInt = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const norm = (v: any) => String(v ?? "").trim();
const normLike = (v: any) => `%${norm(v)}%`;

const upload = multer({ dest: path.join(process.cwd(), "tmp") });

const SHIPMENT_STATUS = {
  PENDING: "pending",
  UNDER_PACKING: "under_packing",
  PACKED: "packed",
  DISPATCHED: "dispatched",
  DELIVERED: "delivered",
  RETURNED: "returned",
  INVALID: "invalid",
};

const DELIVERY_MODE = {
  HOME: "home_delivery",
  TEMPLE: "temple_pickup",
  DONATION: "donation",
};

function offlineOrdersWhere(alias = "o") {
  return `
    COALESCE(${alias}.payment_id, '') LIKE 'AGT%'
  `;
}

function onlineOrdersWhere(alias = "o") {
  return `
    COALESCE(${alias}.payment_id, '') NOT LIKE 'AGT%'
  `;
}

function shipmentsVisibleOrdersWhere(alias = "o") {
  return `
    COALESCE(${alias}.payment_id, '') NOT LIKE 'DEV_%'
  `;
}

function onlinePaymentSessionsWhere(alias = "ps") {
  return `
    COALESCE(${alias}.payment_id, '') NOT LIKE 'OFFLINE_%'
    AND COALESCE(${alias}.payment_id, '') NOT LIKE 'DEV_%'
  `;
}

//UPLOAD AND DOWNLOAD helpers starts here

function csvEscape(v: any) {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function normalizeCell(v: any) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function normalizeCompare(v: any) {
  return normalizeCell(v).toLowerCase();
}

function buildShipmentBooksLabel(regularBooks: string, bonusBooks: string) {
  const a = normalizeCell(regularBooks);
  const b = normalizeCell(bonusBooks);
  if (a && b) return `${a} | Bonus: ${b}`;
  return a || b || "";
}

function getUsersRollupSql(whereSql: string, limitPlaceholder?: string) {
  return `
    WITH user_rollup AS (
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.role,
        u.created_at,

        COALESCE(oa.total_orders, 0) AS total_orders,
        COALESCE(oa.paid_orders, 0) AS paid_orders,
        COALESCE(oa.failed_orders, 0) AS failed_orders,
        COALESCE(oa.pending_orders, 0) AS pending_orders,

        COALESCE(psa.total_payment_sessions, 0) AS total_payment_sessions,
        COALESCE(psa.paid_sessions, 0) AS paid_sessions,
        COALESCE(psa.failed_sessions, 0) AS failed_sessions,
        COALESCE(psa.pending_sessions, 0) AS pending_sessions,
        psa.last_payment_attempt_at,

        CASE
          WHEN COALESCE(oa.paid_orders, 0) > 0 OR COALESCE(psa.paid_sessions, 0) > 0 THEN 'paid'
          ELSE 'unpaid'
        END AS payment_bucket,

        CASE
          WHEN COALESCE(oa.paid_orders, 0) > 0 OR COALESCE(psa.paid_sessions, 0) > 0 THEN 'successful_payment'
          WHEN COALESCE(oa.failed_orders, 0) > 0 OR COALESCE(psa.failed_sessions, 0) > 0 THEN 'failed_attempt'
          WHEN COALESCE(oa.total_orders, 0) > 0 OR COALESCE(psa.total_payment_sessions, 0) > 0 THEN 'pending_attempt'
          ELSE 'registered_only'
        END AS payment_bucket_detail

      FROM users u

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(o.payment_status, '')) = 'paid'
          )::int AS paid_orders,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(o.payment_status, '')) IN ('failed', 'failure', 'cancelled', 'canceled', 'error')
          )::int AS failed_orders,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(o.payment_status, 'pending')) NOT IN ('paid', 'failed', 'failure', 'cancelled', 'canceled', 'error')
          )::int AS pending_orders
        FROM orders o
        WHERE o.user_id = u.id
      ) oa ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total_payment_sessions,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(ps.status, '')) = 'paid'
          )::int AS paid_sessions,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(ps.status, '')) IN ('failed', 'failure', 'cancelled', 'canceled', 'error')
          )::int AS failed_sessions,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(ps.status, 'pending')) NOT IN ('paid', 'failed', 'failure', 'cancelled', 'canceled', 'error')
          )::int AS pending_sessions,
          MAX(ps.created_at) AS last_payment_attempt_at
        FROM payment_sessions ps
        WHERE ps.user_id = u.id
      ) psa ON TRUE
    )

    SELECT *
    FROM user_rollup ur
    ${whereSql}
    ORDER BY ur.created_at DESC
    ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ""}
  `;
}


async function fetchShipmentStatsByMode(
  deliveryMode: "home_delivery" | "temple_pickup" | "all"
) {
  const params: any[] = [];
  const where: string[] = [
    `o.payment_status = 'paid'`,
    `o.book_option = 'book'`,
    shipmentsVisibleOrdersWhere("o"),
  ];

  if (deliveryMode !== "all") {
    where.push(`LOWER(COALESCE(sh.delivery_mode, '')) = $${params.length + 1}`);
    params.push(deliveryMode.toLowerCase());
  }

  const q = await pool.query(
    `
    SELECT
      COALESCE(LOWER(sh.status), 'pending') AS status,
      COUNT(DISTINCT sh.id)::int AS c
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    WHERE ${where.join(" AND ")}
    GROUP BY COALESCE(LOWER(sh.status), 'pending')
    `,
    params
  );

  const map: Record<string, number> = {
    pending: 0,
    under_packing: 0,
    packed: 0,
    dispatched: 0,
    delivered: 0,
    handed_over: 0,
    returned: 0,
    invalid: 0,
  };

  for (const row of q.rows) {
    map[String(row.status || "").toLowerCase()] = Number(row.c || 0);
  }

  return map;
}

async function fetchAllShipmentTabStats() {
  const [home, temple, all] = await Promise.all([
    fetchShipmentStatsByMode("home_delivery"),
    fetchShipmentStatsByMode("temple_pickup"),
    fetchShipmentStatsByMode("all"),
  ]);

  return { home, temple, all };
}

async function fetchShipmentCsvRows(req: any) {
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
 STRING_AGG( 
  (COALESCE(si.book_title, '') || ' - ' || COALESCE(si.book_language, '')),
  ', ' ORDER BY COALESCE(c.title, ''), COALESCE(si.book_title, ''), COALESCE(si.book_language, ''), si.id
) AS regular_books_with_language,

STRING_AGG(
  (COALESCE(c.title, '')),
  ', ' ORDER BY COALESCE(c.title, ''), si.id
) AS contest_titles,

      bonus.bonus_books_with_language,

      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.delivery_mode,
      sh.status,
      sh.updated_at

    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id

    LEFT JOIN LATERAL (
      SELECT
	STRING_AGG(	
      (COALESCE(sbi.book_title, '') || ' - ' || COALESCE(sbi.book_language, '')),
		  ', ' ORDER BY COALESCE(sbi.book_title, ''), COALESCE(sbi.book_language, ''), sbi.id
	) AS bonus_books_with_language

      FROM shipment_bonus_items sbi
      WHERE sbi.shipment_id = sh.id
    ) bonus ON TRUE

    ${whereSql}
    GROUP BY
      sh.id, sh.payment_id, u.id, u.name, u.email, u.phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at,
      bonus.bonus_books_with_language

    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
    `,
    params
  );

  return q.rows.map((r: any) => ({
    ...r,
    books_display: buildShipmentBooksLabel(r.regular_books_with_language, r.bonus_books_with_language),
  }));
}

//UPLOAD AND DOWNLOAD helpers end here


async function fetchShipmentPageRows(req: any) {
  const { whereSql, params } = buildShipmentsFilter(req);
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  const countQ = await pool.query(
    `
    SELECT COUNT(DISTINCT sh.id)::int AS total_count
    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id
    ${whereSql}
    `,
    params
  );

  const listQ = await pool.query(
    `
    SELECT
      sh.id AS shipment_id,
      sh.payment_id,
      u.id AS user_id,
      u.name AS user_name,
      u.email,
      u.phone,
      STRING_AGG(
      (COALESCE(c.title, '')),
      ', ' ORDER BY COALESCE(c.title, ''), si.id
    ) AS contest_titles,
    
    STRING_AGG(
      (COALESCE(si.book_title, '') || ' - ' || COALESCE(si.book_language, '')),
      ', ' ORDER BY COALESCE(c.title, ''), COALESCE(si.book_title, ''), COALESCE(si.book_language, ''), si.id
    ) AS regular_books_with_language,
      
      bonus.bonus_books_with_language,

      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.delivery_mode,
      sh.status,
      sh.updated_at

    FROM shipments sh
    JOIN shipment_items si ON si.shipment_id = sh.id
    JOIN orders o ON o.id = si.order_id
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id

    LEFT JOIN LATERAL (
      SELECT
        STRING_AGG(
        (COALESCE(sbi.book_title, '') || ' - ' || COALESCE(sbi.book_language, '')),
        ', ' ORDER BY COALESCE(sbi.book_title, ''), COALESCE(sbi.book_language, ''), sbi.id
      ) AS bonus_books_with_language
        
      FROM shipment_bonus_items sbi
      WHERE sbi.shipment_id = sh.id
    ) bonus ON TRUE

    ${whereSql}
    GROUP BY
      sh.id, sh.payment_id, u.id, u.name, u.email, u.phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at,
      bonus.bonus_books_with_language

    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
    `,
    [...params, pageSize, offset]
  );

  const totalCount = Number(countQ.rows[0]?.total_count || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const items = listQ.rows.map((r: any) => ({
    ...r,
    books_display: buildShipmentBooksLabel(r.regular_books_with_language, r.bonus_books_with_language),
  }));

  return {
    items,
    page,
    pageSize,
    totalCount,
    totalPages,
  };
}

type RzpOrderPayment = {
  id: string;
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  method?: string;
  captured?: boolean;
  created_at?: number;
};

type RzpOrderPaymentsResp = {
  items?: RzpOrderPayment[];
  count?: number;
};

function hasRzpEnv() {
  return !!(process.env.RZP_KEY_ID && process.env.RZP_KEY_SECRET);
}

function rzpRequest<T>(method: "GET" | "POST", path: string, body?: any): Promise<T> {
  const keyId = process.env.RZP_KEY_ID || "";
  const keySecret = process.env.RZP_KEY_SECRET || "";
  if (!keyId || !keySecret) {
    return Promise.reject(new Error("Missing Razorpay keys. Set RZP_KEY_ID and RZP_KEY_SECRET in .env"));
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const payload = body ? JSON.stringify(body) : "";

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.razorpay.com",
        path,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : {};
          } catch {
            json = {};
          }

          if (statusCode >= 200 && statusCode < 300) return resolve(json as T);

          const msg =
            json?.error?.description ||
            json?.error?.message ||
            `Razorpay API error (${statusCode})`;

          return reject(new Error(msg));
        });
      }
    );

    req.setTimeout(12000, () => {
      req.destroy(new Error("Razorpay request timeout after 12s"));
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function buildUser360ReconcilePreview(userId: string, paymentSessionId: string) {
  const localQ = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    WHERE ps.id=$1 AND ps.user_id=$2
    GROUP BY ps.id, ps.payment_id, ps.status, ps.amount, ps.created_at
    LIMIT 1
    `,
    [paymentSessionId, userId]
  );

  if (!localQ.rows.length) return null;

  const local = localQ.rows[0];
  const expectedAmountPaise = Math.round(Number(local.session_amount || 0) * 100);

  const preview: any = {
    local,
    selectedPayment: null,
    payments: [],
    apiError: "",
    amountMatches: false,
    amountAtLeastExpected: false,
    canApplyPaid: false,
    razorpayEnabled: hasRzpEnv(),
    capturedAmountPaise: 0,
    capturedAmount: 0,
    expectedAmountPaise,
    overCollectedAmount: 0,
    underpaidAmount: 0,
    isHigherAmount: false,
    decision: "unknown",
    decisionLabel: "Review manually",
  };

  const gatewayOrderId = String(local.gateway_order_id || "");

  if (!preview.razorpayEnabled) {
    preview.apiError = "Razorpay keys are not configured on this server.";
    preview.decision = "api_error";
    preview.decisionLabel = "API issue";
    return preview;
  }

  if (!gatewayOrderId) {
    preview.apiError = "Gateway order id not found on payment session.";
    preview.decision = "api_error";
    preview.decisionLabel = "API issue";
    return preview;
  }

  if (gatewayOrderId.startsWith("DEV_")) {
    preview.apiError = "Skipped DEV payment session.";
    preview.decision = "skipped_dev";
    preview.decisionLabel = "DEV session";
    return preview;
  }

  try {
    const resp = await rzpRequest<RzpOrderPaymentsResp>(
      "GET",
      `/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`
    );

    const payments = Array.isArray(resp?.items) ? resp.items : [];
    preview.payments = payments;

    const sorted = payments.slice().sort((a, b) => {
      const rank = (p: any) => {
        const st = String(p?.status || "").toLowerCase();
        if (st === "captured") return 3;
        if (st === "authorized") return 2;
        if (st === "created") return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (rb !== ra) return rb - ra;
      return Number(b?.created_at || 0) - Number(a?.created_at || 0);
    });

    const selected = sorted[0] || null;
    preview.selectedPayment = selected;
    preview.capturedAmountPaise = Number(selected?.amount || 0);
    preview.capturedAmount = preview.capturedAmountPaise / 100;
    preview.amountMatches = !!selected && preview.capturedAmountPaise === expectedAmountPaise;
    preview.amountAtLeastExpected = !!selected && preview.capturedAmountPaise >= expectedAmountPaise;
    preview.isHigherAmount = !!selected && preview.capturedAmountPaise > expectedAmountPaise;
    preview.overCollectedAmount = Math.max(0, (preview.capturedAmountPaise - expectedAmountPaise) / 100);
    preview.underpaidAmount = Math.max(0, (expectedAmountPaise - preview.capturedAmountPaise) / 100);
    preview.canApplyPaid =
      !!selected &&
      String(selected.status || "").toLowerCase() === "captured" &&
      preview.amountAtLeastExpected;
  } catch (e: any) {
    preview.apiError = e?.message || "Failed to fetch Razorpay payment details.";
  }

  const localPaid = String(local.session_status || "").toLowerCase() === "paid";
  if (localPaid) {
    preview.decision = "local_paid";
    preview.decisionLabel = "Already paid locally";
  } else if (preview.apiError) {
    preview.decision = "api_error";
    preview.decisionLabel = "API issue";
  } else if (!preview.selectedPayment) {
    preview.decision = "no_payment_found";
    preview.decisionLabel = "No payment found";
  } else {
    const st = String(preview.selectedPayment.status || "").toLowerCase();
    if (st === "captured") {
      if (preview.capturedAmountPaise < expectedAmountPaise) {
        preview.decision = "underpaid";
        preview.decisionLabel = "Captured but underpaid";
      } else if (preview.capturedAmountPaise === expectedAmountPaise) {
        preview.decision = "safe_exact";
        preview.decisionLabel = "Safe exact";
      } else {
        preview.decision = "safe_higher";
        preview.decisionLabel = "Safe higher amount";
      }
    } else if (st === "authorized") {
      preview.decision = "authorized_only";
      preview.decisionLabel = "Authorized only";
    }
  }

  return preview;
}


type BulkDecision =
  | "safe_exact"
  | "safe_higher"
  | "underpaid"
  | "authorized_only"
  | "no_payment_found"
  | "api_error"
  | "skipped_dev"
  | "local_paid"
  | "unknown";

type BulkReconcileRow = {
  payment_session_id: string;
  user_id: string;
  user_name: string;
  email: string;
  phone: string;
  gateway_order_id: string;
  internal_payment_id: string;
  session_status: string;
  session_amount: number;
  created_at: string;
  order_count: number;
  order_statuses: string;
  selectedPayment: any;
  payments: any[];
  apiError: string;
  amountMatches: boolean;
  amountAtLeastExpected: boolean;
  canApplyPaid: boolean;
  razorpayEnabled: boolean;
  capturedAmount: number;
  capturedAmountPaise: number;
  expectedAmountPaise: number;
  overCollectedAmount: number;
  underpaidAmount: number;
  isHigherAmount: boolean;
  decision: BulkDecision;
  decisionLabel: string;
};

type BulkReconcileFilters = {
  localStatus?: string;
  decision?: string;
  q?: string;
  scanAll?: boolean;
  page?: number;
  pageSize?: number;
  limit?: number;
};

function getBulkDecisionMeta(decision: BulkDecision) {
  switch (decision) {
    case "safe_exact":
      return { label: "Safe exact", sortRank: 1 };
    case "safe_higher":
      return { label: "Safe higher amount", sortRank: 2 };
    case "underpaid":
      return { label: "Captured but underpaid", sortRank: 3 };
    case "authorized_only":
      return { label: "Authorized only", sortRank: 4 };
    case "no_payment_found":
      return { label: "No payment found", sortRank: 5 };
    case "api_error":
      return { label: "API issue", sortRank: 6 };
    case "skipped_dev":
      return { label: "DEV session", sortRank: 7 };
    case "local_paid":
      return { label: "Already paid locally", sortRank: 8 };
    default:
      return { label: "Review manually", sortRank: 9 };
  }
}

function isRecoverableBulkDecision(decision: BulkDecision) {
  return decision === "safe_exact" || decision === "safe_higher";
}

function classifyBulkDecision(args: {
  sessionStatus: string;
  apiError: string;
  gatewayOrderId: string;
  selectedPayment: any;
  expectedAmountPaise: number;
}) {
  const localPaid = String(args.sessionStatus || "").toLowerCase() === "paid";
  if (localPaid) return "local_paid" as BulkDecision;
  if (String(args.gatewayOrderId || "").startsWith("DEV_")) return "skipped_dev" as BulkDecision;
  if (args.apiError) return "api_error" as BulkDecision;
  if (!args.selectedPayment) return "no_payment_found" as BulkDecision;

  const st = String(args.selectedPayment?.status || "").toLowerCase();
  const amt = Number(args.selectedPayment?.amount || 0);

  if (st === "captured") {
    if (amt < args.expectedAmountPaise) return "underpaid" as BulkDecision;
    if (amt === args.expectedAmountPaise) return "safe_exact" as BulkDecision;
    return "safe_higher" as BulkDecision;
  }

  if (st === "authorized") return "authorized_only" as BulkDecision;
  return "unknown" as BulkDecision;
}

function buildBulkReconcileBaseSql(filters: BulkReconcileFilters) {
  const localStatus = String(filters.localStatus || "all").trim().toLowerCase();
  const q = String(filters.q || "").trim();

  /*const where: string[] = [
    `COALESCE(ps.payment_id, '') <> ''`,
    `COALESCE(ps.payment_id, '') NOT LIKE 'DEV_%'`,
  ];
  */

  const where: string[] = [
  `COALESCE(ps.payment_id, '') <> ''`,
  onlinePaymentSessionsWhere("ps"),
];
  const params: any[] = [];

  if (localStatus === "pending" || localStatus === "failed" || localStatus === "paid") {
    where.push(`COALESCE(LOWER(ps.status), 'pending') = $${params.length + 1}`);
    params.push(localStatus);
  } else {
    // For reconciliation page, "all" should show unreconciled candidates only
    where.push(`COALESCE(LOWER(ps.status), 'pending') IN ('pending', 'failed')`);
  }

  if (q) {
    where.push(`(
      u.name ILIKE $${params.length + 1}
      OR u.email ILIKE $${params.length + 1}
      OR u.phone ILIKE $${params.length + 1}
      OR ps.payment_id ILIKE $${params.length + 1}
      OR CAST(ps.id AS text) ILIKE $${params.length + 1}
    )`);
    params.push(normLike(q));
  }

  return {
    whereSql: `WHERE ${where.join(" AND ")}`,
    params,
  };
}

async function buildReconcilePreviewBySessionId(paymentSessionId: string) {
  const localQ = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.user_id,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    WHERE ps.id=$1
    GROUP BY ps.id, ps.user_id, ps.payment_id, ps.status, ps.amount, ps.created_at
    LIMIT 1
    `,
    [paymentSessionId]
  );

  if (!localQ.rows.length) return null;

  const local = localQ.rows[0];
  const preview: any = {
    local,
    selectedPayment: null,
    payments: [],
    apiError: "",
    amountMatches: false,
    amountAtLeastExpected: false,
    canApplyPaid: false,
    razorpayEnabled: hasRzpEnv(),
    capturedAmountPaise: 0,
    capturedAmount: 0,
    expectedAmountPaise: Math.round(Number(local.session_amount || 0) * 100),
    overCollectedAmount: 0,
    underpaidAmount: 0,
    isHigherAmount: false,
    decision: "unknown" as BulkDecision,
    decisionLabel: "Review manually",
  };

  const gatewayOrderId = String(local.gateway_order_id || "");

  if (!preview.razorpayEnabled) {
    preview.apiError = "Razorpay keys are not configured on this server.";
    preview.decision = "api_error";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  if (!gatewayOrderId) {
    preview.apiError = "Gateway order id not found on payment session.";
    preview.decision = "api_error";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  if (gatewayOrderId.startsWith("DEV_")) {
    preview.apiError = "Skipped DEV payment session.";
    preview.decision = "skipped_dev";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  try {
    const resp = await rzpRequest<RzpOrderPaymentsResp>(
      "GET",
      `/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`
    );

    const payments = Array.isArray(resp?.items) ? resp.items : [];
    preview.payments = payments;

    const sorted = payments.slice().sort((a, b) => {
      const rank = (p: any) => {
        const st = String(p?.status || "").toLowerCase();
        if (st === "captured") return 3;
        if (st === "authorized") return 2;
        if (st === "created") return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (rb !== ra) return rb - ra;
      return Number(b?.created_at || 0) - Number(a?.created_at || 0);
    });

    const selected = sorted[0] || null;
    preview.selectedPayment = selected;
    preview.capturedAmountPaise = Number(selected?.amount || 0);
    preview.capturedAmount = preview.capturedAmountPaise / 100;
    preview.amountMatches = !!selected && preview.capturedAmountPaise === preview.expectedAmountPaise;
    preview.amountAtLeastExpected = !!selected && preview.capturedAmountPaise >= preview.expectedAmountPaise;
    preview.isHigherAmount = !!selected && preview.capturedAmountPaise > preview.expectedAmountPaise;
    preview.overCollectedAmount = Math.max(0, (preview.capturedAmountPaise - preview.expectedAmountPaise) / 100);
    preview.underpaidAmount = Math.max(0, (preview.expectedAmountPaise - preview.capturedAmountPaise) / 100);
    preview.canApplyPaid =
      !!selected &&
      String(selected.status || "").toLowerCase() === "captured" &&
      preview.amountAtLeastExpected;
  } catch (e: any) {
    preview.apiError = e?.message || "Failed to fetch Razorpay payment details.";
  }

  preview.decision = classifyBulkDecision({
    sessionStatus: local.session_status,
    apiError: preview.apiError,
    gatewayOrderId,
    selectedPayment: preview.selectedPayment,
    expectedAmountPaise: preview.expectedAmountPaise,
  });
  preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;

  return preview;
}

async function buildBulkReconcileRows(filters: BulkReconcileFilters): Promise<BulkReconcileRow[]> {
  const scanAll = !!filters.scanAll;
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(10, Math.min(500, Number(filters.pageSize || 100)));
  const limit = Math.max(1, Math.min(5000, Number(filters.limit || (page * pageSize))));

  const base = buildBulkReconcileBaseSql(filters);
  const limitSql = scanAll ? "" : `LIMIT $${base.params.length + 1}`;
  const params = scanAll ? base.params.slice() : base.params.concat([limit]);

  const q = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.user_id,
      u.name AS user_name,
      u.email,
      u.phone,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    JOIN users u ON u.id = ps.user_id
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    ${base.whereSql}
    GROUP BY
      ps.id, ps.user_id, u.name, u.email, u.phone,
      ps.payment_id, ps.status, ps.amount, ps.created_at
    ORDER BY ps.created_at DESC
    ${limitSql}
    `,
    params
  );

  const rows: BulkReconcileRow[] = [];

  for (const row of q.rows) {
    const preview = await buildReconcilePreviewBySessionId(String(row.payment_session_id));
    const decision = preview?.decision || "unknown";
    const decisionMeta = getBulkDecisionMeta(decision);

    rows.push({
      ...row,
      selectedPayment: preview?.selectedPayment || null,
      payments: preview?.payments || [],
      apiError: preview?.apiError || "",
      amountMatches: !!preview?.amountMatches,
      amountAtLeastExpected: !!preview?.amountAtLeastExpected,
      canApplyPaid: !!preview?.canApplyPaid,
      razorpayEnabled: !!preview?.razorpayEnabled,
      capturedAmount: Number(preview?.capturedAmount || 0),
      capturedAmountPaise: Number(preview?.capturedAmountPaise || 0),
      expectedAmountPaise: Number(preview?.expectedAmountPaise || 0),
      overCollectedAmount: Number(preview?.overCollectedAmount || 0),
      underpaidAmount: Number(preview?.underpaidAmount || 0),
      isHigherAmount: !!preview?.isHigherAmount,
      decision,
      decisionLabel: decisionMeta.label,
    });
  }

  return rows;
}

function filterBulkRowsByDecision(rows: BulkReconcileRow[], decision: string) {
  if (!decision || decision === "all") return rows;
  return rows.filter((r) => String(r.decision || "") === decision);
}

function paginateBulkRows(rows: BulkReconcileRow[], page: number, pageSize: number) {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(safePage, pageCount);
  const start = (currentPage - 1) * safePageSize;
  const items = rows.slice(start, start + safePageSize);
  return { items, total, pageCount, currentPage, pageSize: safePageSize };
}

function isFailedLikePaymentStatus(status: any) {
  const s = String(status || '').trim().toLowerCase();
  return ['failed', 'failure', 'cancelled', 'canceled', 'error'].includes(s);
}

async function applyFailedForPendingSession(args: { paymentSessionId: string; adminUserId?: string | null }) {
  const preview = await buildReconcilePreviewBySessionId(args.paymentSessionId);
  if (!preview?.local) {
    return { ok: false, reason: 'payment_session_not_found', updated: false, preview: null };
  }

  const localStatus = String(preview.local.session_status || '').trim().toLowerCase();
  const rpStatus = String(preview.selectedPayment?.status || '').trim().toLowerCase();

  if (localStatus !== 'pending') {
    return { ok: false, reason: 'local_not_pending', updated: false, preview };
  }

  if (!isFailedLikePaymentStatus(rpStatus)) {
    return { ok: false, reason: 'razorpay_not_failed', updated: false, preview };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const psQ = await client.query(
      `
      UPDATE payment_sessions
      SET status = 'failed'
      WHERE id = $1 AND COALESCE(LOWER(status), 'pending') = 'pending'
      RETURNING id
      `,
      [args.paymentSessionId]
    );

    const ordersQ = await client.query(
      `
      UPDATE orders o
      SET payment_status = 'failed'
      WHERE o.payment_session_id = $1
        AND COALESCE(LOWER(o.payment_status), 'pending') = 'pending'
        AND COALESCE(o.payment_id, '') LIKE 'KNC%'
      RETURNING o.id
      `,
      [args.paymentSessionId]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      reason: 'applied_failed',
      updated: (psQ.rowCount ?? 0) > 0 || (ordersQ.rowCount ?? 0) > 0,
      updatedOrders: ordersQ.rowCount ?? 0,
      preview,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}


type OrdersFailedReconcileJob = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  total: number;
  scanned: number;
  applied: number;
  skipped: number;
  failedLookups: number;
  currentPaymentSessionId: string;
  currentOrderGroup: string;
  message: string;
  error?: string;
};

const ordersFailedReconcileJobs = new Map<string, OrdersFailedReconcileJob>();

function createOrdersFailedReconcileJob(total: number) {
  const id = `ordfail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job: OrdersFailedReconcileJob = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    total,
    scanned: 0,
    applied: 0,
    skipped: 0,
    failedLookups: 0,
    currentPaymentSessionId: '',
    currentOrderGroup: '',
    message: total > 0 ? 'Starting bulk reconcile…' : 'No pending groups found for this filter.',
  };
  ordersFailedReconcileJobs.set(id, job);
  return job;
}

async function runOrdersFailedReconcileJob(jobId: string, groups: Array<{ payment_session_id: string | null; order_group_id: string | null }>, adminUserId?: string | null) {
  const job = ordersFailedReconcileJobs.get(jobId);
  if (!job) return;

  try {
    for (const row of groups) {
      const paymentSessionId = String(row.payment_session_id || '').trim();
      const orderGroupId = String(row.order_group_id || '').trim();
      job.currentPaymentSessionId = paymentSessionId;
      job.currentOrderGroup = orderGroupId;
      job.message = `Scanning ${job.scanned + 1} of ${job.total}`;

      if (!paymentSessionId) {
        job.scanned += 1;
        job.skipped += 1;
        job.message = `Skipped ${orderGroupId || 'group'} because payment session is missing.`;
        continue;
      }

      try {
        const result = await applyFailedForPendingSession({
          paymentSessionId,
          adminUserId: adminUserId || null,
        });

        job.scanned += 1;

        if (result.ok && result.updated) {
          job.applied += 1;
          job.message = `Applied pending → failed for ${orderGroupId || paymentSessionId}.`;
        } else {
          job.skipped += 1;
          if (String(result.reason || '') === 'payment_session_not_found' || String(result.reason || '').includes('razorpay')) {
            job.failedLookups += 1;
          }
          job.message = `Skipped ${orderGroupId || paymentSessionId}: ${String(result.reason || 'not_applicable').replace(/_/g, ' ')}.`;
        }
      } catch (err: any) {
        job.scanned += 1;
        job.skipped += 1;
        job.failedLookups += 1;
        job.message = `Skipped ${orderGroupId || paymentSessionId}: ${err?.message || 'unexpected error'}`;
      }
    }

    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    job.currentPaymentSessionId = '';
    job.currentOrderGroup = '';
    job.message = `Bulk reconcile complete. Applied: ${job.applied}. Skipped: ${job.skipped}.`;
  } catch (err: any) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = err?.message || 'Failed to run bulk reconcile job';
    job.message = job.error || 'Failed to run bulk reconcile job';
  }
}

async function getCurrentDbPaidRevenue() {
  const q = await pool.query(`
    SELECT COALESCE(SUM(o.amount),0)::numeric AS total
    FROM orders o
    WHERE ${onlineOrdersWhere("o")} AND o.payment_status='paid'
  `);
  return Number(q.rows[0]?.total || 0);
}

function summarizeBulkRows(rows: BulkReconcileRow[], currentDbRevenue: number) {
  const summary = {
    total: rows.length,
    safeExact: 0,
    safeHigher: 0,
    safeTotal: 0,
    localPending: 0,
    localFailed: 0,
    localPaid: 0,
    underpaid: 0,
    authorizedOnly: 0,
    noPaymentFound: 0,
    apiError: 0,
    currentDbRevenue,
    recoverableRevenue: 0,
    projectedRevenue: currentDbRevenue,
    gatewayExtraOverExpected: 0,
    underpaidGap: 0,
    safeOrderCount: 0,
  };

  for (const r of rows) {
    const localStatus = String(r.session_status || "").toLowerCase();

    if (localStatus === "pending") summary.localPending++;
    else if (localStatus === "failed") summary.localFailed++;
    else if (localStatus === "paid") summary.localPaid++;

    // Already paid locally must not inflate recoverable/projected numbers
    if (r.decision === "local_paid") {
      continue;
    }

    if (r.decision === "safe_exact") {
      summary.safeExact++;
      summary.safeTotal++;
      summary.recoverableRevenue += Number(r.session_amount || 0);
      summary.safeOrderCount += Number(r.order_count || 0);
    } else if (r.decision === "safe_higher") {
      summary.safeHigher++;
      summary.safeTotal++;
      summary.recoverableRevenue += Number(r.session_amount || 0);
      summary.gatewayExtraOverExpected += Number(r.overCollectedAmount || 0);
      summary.safeOrderCount += Number(r.order_count || 0);
    } else if (r.decision === "underpaid") {
      summary.underpaid++;
      summary.underpaidGap += Number(r.underpaidAmount || 0);
    } else if (r.decision === "authorized_only") {
      summary.authorizedOnly++;
    } else if (r.decision === "no_payment_found") {
      summary.noPaymentFound++;
    } else if (r.decision === "api_error") {
      summary.apiError++;
    }
  }

  summary.projectedRevenue = summary.currentDbRevenue + summary.recoverableRevenue;
  return summary;
}


async function applyPaidForSessionFromPreview(args: {
  paymentSessionId: string;
  adminActor: string;
}) {
  const preview = await buildReconcilePreviewBySessionId(args.paymentSessionId);

  if (!preview || !preview.local) {
    return { ok: false, reason: "Payment session not found" };
  }

  if (String(preview.local.session_status || "").toLowerCase() === "paid") {
    return { ok: false, reason: "Already marked paid" };
  }

  if (!preview.canApplyPaid) {
    return { ok: false, reason: "Razorpay has not confirmed a captured payment with amount at least equal to local amount" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE payment_sessions
       SET status='paid'
       WHERE id=$1 AND status <> 'paid'`,
      [args.paymentSessionId]
    );

    await client.query(
      `UPDATE orders
       SET payment_status='paid'
       WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [args.paymentSessionId]
    );

    await client.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        args.paymentSessionId,
        "admin_bulk_reconcile_apply",
        JSON.stringify({
          paymentSessionId: args.paymentSessionId,
          gatewayOrderId: preview.local.gateway_order_id,
          internalPaymentId: preview.local.internal_payment_id,
          razorpayPaymentId: preview.selectedPayment?.id || null,
          razorpayStatus: preview.selectedPayment?.status || null,
          expectedAmount: Number(preview.local.session_amount || 0),
          capturedAmount: Number(preview.capturedAmount || 0),
          amountMatches: preview.amountMatches,
          amountAtLeastExpected: preview.amountAtLeastExpected,
          overCollectedAmount: preview.overCollectedAmount,
          decision: preview.decision,
          adminActor: args.adminActor,
          at: new Date().toISOString(),
        }),
      ]
    );

    await client.query("COMMIT");
    return { ok: true, decision: preview.decision };
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error("bulk reconcile apply error:", e);
    return { ok: false, reason: e?.message || "Failed to apply paid status" };
  } finally {
    client.release();
  }
}



async function buildContestConfirmationInputForSession(paymentSessionId: string) {
  const q = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.user_id,
      u.name AS user_name,
      u.phone,
      o.payment_id AS internal_payment_id,
      c.title AS contest_title
    FROM payment_sessions ps
    JOIN users u ON u.id = ps.user_id
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    LEFT JOIN contests c ON c.id = o.contest_id
    WHERE ps.id = $1
    ORDER BY o.created_at ASC NULLS LAST, c.title ASC NULLS LAST
    `,
    [paymentSessionId]
  );

  if (!q.rows.length) return null;

  const first = q.rows[0];
  const paymentId = String(first.internal_payment_id || "").trim();
  const userId = String(first.user_id || "").trim();
  const phone = String(first.phone || "").trim();
  const userName = String(first.user_name || "Participant").trim() || "Participant";

  const contestTitles = Array.from(
    new Set(
      q.rows
        .map((r: any) => String(r.contest_title || "").trim())
        .filter(Boolean)
    )
  );

  if (!paymentId || !userId || !phone) return null;

  return {
    paymentId,
    paymentSessionId,
    userId,
    phone,
    userName,
    contestTitles,
  };
}

async function reconcileSessionAndMaybeSend(args: {
  paymentSessionId: string;
  adminActor: string;
  sendMessage?: boolean;
}) {
  const reconcileResult = await applyPaidForSessionFromPreview({
    paymentSessionId: args.paymentSessionId,
    adminActor: args.adminActor,
  });

  if (!reconcileResult.ok) {
    return {
      ok: false,
      reconcile: reconcileResult,
      message: null as any,
    };
  }

  if (!args.sendMessage) {
    return {
      ok: true,
      reconcile: reconcileResult,
      message: null as any,
    };
  }

  try {
    const input = await buildContestConfirmationInputForSession(args.paymentSessionId);
    if (!input) {
      return {
        ok: true,
        reconcile: reconcileResult,
        message: {
          ok: false,
          skipped: true,
          reason: "missing_message_context",
        },
      };
    }

    const messageResult = await sendContestRegistrationMessageOnce(input);
    return {
      ok: true,
      reconcile: reconcileResult,
      message: messageResult,
    };
  } catch (e: any) {
    return {
      ok: true,
      reconcile: reconcileResult,
      message: {
        ok: false,
        skipped: false,
        reason: e?.message || "message_send_failed",
      },
    };
  }
}

function bulkQueryString(args: {
  localStatus?: string;
  decision?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  scanAll?: boolean;
}) {
  const p = new URLSearchParams();
  if (args.localStatus && args.localStatus !== "all") p.set("local_status", args.localStatus);
  if (args.decision && args.decision !== "all") p.set("decision", args.decision);
  if (args.q) p.set("q", args.q);
  if (args.page && args.page > 1) p.set("page", String(args.page));
  if (args.pageSize) p.set("page_size", String(args.pageSize));
  if (args.scanAll) p.set("scan_all", "1");
  p.set("scan", "1");
  return p.toString();
}

function genBatchNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `IP-${y}${m}${day}-${rand}`;
}

/*
function csvEscape(v: any) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
*/
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


function buildFeedbackFilter(req: any, opts: { ignoreStatus?: boolean } = {}) {
  const status = norm(req.query.status || "open").toLowerCase();
  const q = norm(req.query.q || "");

  const where: string[] = [];
  const params: any[] = [];

  if (!opts.ignoreStatus && status !== "all") {
    where.push(`LOWER(COALESCE(f.status,'open')) = $${params.length + 1}`);
    params.push(status);
  }

  if (q) {
    where.push(`(
      COALESCE(f.message,'') ILIKE $${params.length + 1}
      OR COALESCE(u.name,'') ILIKE $${params.length + 1}
      OR COALESCE(u.email,'') ILIKE $${params.length + 1}
      OR COALESCE(u.phone,'') ILIKE $${params.length + 1}
      OR CAST(f.id AS text) ILIKE $${params.length + 1}
      OR CAST(f.user_id AS text) ILIKE $${params.length + 1}
    )`);
    params.push(normLike(q));
  }

  return {
    status,
    q,
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function feedbackQueryString(args: { status?: string; q?: string }) {
  const p = new URLSearchParams();
  if (args.status && args.status !== "open") p.set("status", args.status);
  else if (args.status === "open") p.set("status", "open");
  if (args.q) p.set("q", args.q);
  return p.toString();
}

function normPhone10(v: any) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

function mnvGenericPost(payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = https.request(
      "https://backend.api-wa.co/campaign/mnv-solutions/api/v2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }

          if (statusCode >= 200 && statusCode < 300) return resolve(json);

          return reject(
            new Error(`MNV send failed: ${statusCode} ${typeof data === "string" ? data.slice(0, 300) : ""}`)
          );
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sanitizeWhatsappTemplateParam(v: any) {
  return String(v || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function sendAdminFeedbackReply(args: {
  userId: string;
  phone: string;
  userName: string;
  message: string;
  ticketId?: string;
}) {
  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_FEEDBACK_REPLY_CAMPAIGN_NAME || "feedback_reply"
  ).trim();
  const source = String(
    process.env.MNV_FEEDBACK_REPLY_SOURCE || "admin-feedback-reply"
  ).trim();
  const senderName = String(
    process.env.MNV_FEEDBACK_REPLY_USERNAME ||
    process.env.MNV_CONTEST_CONFIRM_USERNAME ||
    "IskconContest"
  ).trim();

  const ticketId = String(args.ticketId || "").trim();
  const phone = normPhone10(args.phone);
  const userName = sanitizeWhatsappTemplateParam(String(args.userName || "Participant")) || "Participant";
  const message = sanitizeWhatsappTemplateParam(args.message);
  const syntheticPaymentId = ticketId ? `FB-${ticketId}` : `FB-USER-${String(args.userId || "").trim()}`;

  if (!phone || !message) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const payload = {
    apiKey,
    campaignName,
    destination: `91${phone}`,
    userName: senderName,
    templateParams: [
      userName,
      message,
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {
      userId: String(args.userId || ""),
      ticketId,
      messageType: "admin_feedback_reply",
    },
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvGenericPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "send_failed";
  }

  try {
    await pool.query(
      `
      INSERT INTO whatsapp_message_logs
        (payment_id, payment_session_id, user_id, phone, message_type, provider, provider_message_id, status, response_text)
      VALUES
        ($1, NULL, $2, $3, 'feedback_reply', 'mnv_whatsapp', $4, $5, $6)
      ON CONFLICT (payment_id, message_type)
      DO UPDATE SET
        provider_message_id = EXCLUDED.provider_message_id,
        status = EXCLUDED.status,
        response_text = EXCLUDED.response_text,
        created_at = CURRENT_TIMESTAMP
      `,
      [
        syntheticPaymentId,
        String(args.userId || "").trim(),
        phone,
        providerMessageId,
        sendStatus,
        responseText,
      ]
    );
  } catch (logErr) {
    console.error("feedback whatsapp log insert/update failed:", logErr);
  }

  if (sendStatus !== "sent") {
    return {
      ok: false,
      skipped: false,
      reason: responseText || "send_failed",
    };
  }

  return {
    ok: true,
    skipped: false,
    providerMessageId,
    sanitizedMessage: message,
  };
}

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
// OVERVIEW
// --------------------
router.get("/admin", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
  const ORDER_IST_DATE = `(o.created_at AT TIME ZONE 'Asia/Kolkata')::date`;

  // online only
  const usersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);

  const ordersAllQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
  `);

  const paidOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
  `);

  const pendingOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='pending'
  `);

  const failedOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='failed'
  `);

  const giftQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
  `);

  const donateQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='donation'
  `);

  const revenueQ = await pool.query(`
    SELECT COALESCE(SUM(o.amount),0)::int AS total
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
  `);

  // today stats with SAME old business logic, just IST-scoped
  const todayOrdersAllQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);


  const todayPaidOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  const todayPendingOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='pending'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  const todayFailedOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='failed'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  const todayGiftQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  const todayDonateQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='donation'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  const todayRevenueQ = await pool.query(`
    SELECT COALESCE(SUM(o.amount),0)::int AS total
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND ${ORDER_IST_DATE} = ${IST_TODAY}
  `);

  // sales chart - keep old intent, fix IST grouping
  const salesDailyQ = await pool.query(`
  SELECT
    TO_CHAR((o.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'DD/MM/YY') AS d,
    COALESCE(SUM(o.amount),0)::int AS revenue
  FROM orders o
  WHERE ${onlineOrdersWhere("o")}
    AND o.payment_status='paid'
    AND (o.created_at AT TIME ZONE 'Asia/Kolkata') >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '30 days')
  GROUP BY (o.created_at AT TIME ZONE 'Asia/Kolkata')::date
  ORDER BY (o.created_at AT TIME ZONE 'Asia/Kolkata')::date ASC
`);

const salesWeeklyQ = await pool.query(`
  SELECT
    TO_CHAR(DATE_TRUNC('week', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date, 'DD/MM/YY') AS w,
    COALESCE(SUM(o.amount),0)::int AS revenue
  FROM orders o
  WHERE ${onlineOrdersWhere("o")}
    AND o.payment_status='paid'
    AND (o.created_at AT TIME ZONE 'Asia/Kolkata') >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '84 days')
  GROUP BY DATE_TRUNC('week', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date
  ORDER BY DATE_TRUNC('week', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date ASC
`);

const salesMonthlyQ = await pool.query(`
  SELECT
    TO_CHAR(DATE_TRUNC('month', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date, 'DD/MM/YY') AS m,
    COALESCE(SUM(o.amount),0)::int AS revenue
  FROM orders o
  WHERE ${onlineOrdersWhere("o")}
    AND o.payment_status='paid'
    AND (o.created_at AT TIME ZONE 'Asia/Kolkata') >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '365 days')
  GROUP BY DATE_TRUNC('month', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date
  ORDER BY DATE_TRUNC('month', (o.created_at AT TIME ZONE 'Asia/Kolkata'))::date ASC
`);

  // keep your shipment logic untouched except online-only filter
  const shipStatusQ = await pool.query(`
    SELECT COALESCE(LOWER(sh.status),'pending') AS status, COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
    GROUP BY COALESCE(LOWER(sh.status),'pending')
    ORDER BY c DESC
  `);

  const packedQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'pending')='packed'
  `);

  const dispatchedQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'') IN ('dispatched','delivered')
  `);

  const pendingDispatchQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    LEFT JOIN shipments sh ON sh.order_id=o.id
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.book_option='book'
      AND COALESCE(LOWER(sh.status),'pending') IN ('pending','under_packing','packed')
  `);

  const contestStatsQ = await pool.query(`
    SELECT
      c.title,
      COUNT(o.id) FILTER (WHERE o.payment_status='paid' AND ${onlineOrdersWhere("o")})::int AS registrations,
      COUNT(s.id)::int AS submitted,
      (
        COUNT(o.id) FILTER (WHERE o.payment_status='paid' AND ${onlineOrdersWhere("o")})
        - COUNT(s.id)
      )::int AS not_submitted
    FROM contests c
    LEFT JOIN orders o ON o.contest_id = c.id
    LEFT JOIN submissions s ON s.order_id = o.id
    GROUP BY c.id, c.title
    ORDER BY c.title ASC
  `);

  const uploadQ = await pool.query(`
    SELECT
      COUNT(*)::int AS files,
      COALESCE(SUM(file_size),0)::bigint AS bytes,
      COUNT(*) FILTER (WHERE file_size IS NULL)::int AS missing_size
    FROM submissions
  `);

  const userSplitQ = await pool.query(`
  ${getUsersRollupCte()}
  SELECT
    COUNT(*) FILTER (WHERE payment_bucket = 'paid')::int AS paid_users,
    COUNT(*) FILTER (WHERE payment_bucket = 'added_to_cart')::int AS pending_users,
    COUNT(*) FILTER (WHERE payment_bucket = 'registered_only')::int AS registered_only_users
  FROM user_rollup ur
`);



  return res.render("admin/admin-dashboard", {
    activeTab: "overview",
    stats: {
      users: usersQ.rows[0].c,
      ordersAll: ordersAllQ.rows[0].c,
      paidOrders: paidOrdersQ.rows[0].c,
      pendingOrders: pendingOrdersQ.rows[0].c + failedOrdersQ.rows[0].c,
      gift: giftQ.rows[0].c,
      donate: donateQ.rows[0].c,
      revenue: revenueQ.rows[0].total,
      todayRevenue: todayRevenueQ.rows[0].total,

      todayOrdersAll: todayOrdersAllQ.rows[0].c,
      todayPaidOrders: todayPaidOrdersQ.rows[0].c,
      todayPendingOrders: todayPendingOrdersQ.rows[0].c + todayFailedOrdersQ.rows[0].c,
      todayGift: todayGiftQ.rows[0].c,
      todayDonate: todayDonateQ.rows[0].c,

      pendingDispatch: pendingDispatchQ.rows[0].c,
      dispatched: dispatchedQ.rows[0].c,
      packed: packedQ.rows[0].c
    },
    series: {
      daily: salesDailyQ.rows,
      weekly: salesWeeklyQ.rows,
      monthly: salesMonthlyQ.rows
    },
    userStats: userSplitQ.rows[0] || {
  paid_users: 0,
  pending_users: 0,
  registered_only_users: 0
},
    shipStatus: shipStatusQ.rows,
    contestStats: contestStatsQ.rows,
    upload: uploadQ.rows[0]
  });
});



router.get("/admin/export/overview.csv", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const usersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);

  const ordersAllQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
  `);

  const paidOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${onlineOrdersWhere("o")} AND o.payment_status='paid'
  `);

  const revenueQ = await pool.query(`
    SELECT COALESCE(SUM(o.amount),0)::int AS total
    FROM orders o
    WHERE ${onlineOrdersWhere("o")} AND o.payment_status='paid'
  `);

  const dailyQ = await pool.query(`
    SELECT DATE(o.created_at) AS d, COALESCE(SUM(o.amount),0)::int AS revenue
    FROM orders o
    WHERE ${onlineOrdersWhere("o")}
      AND o.payment_status='paid'
      AND o.created_at >= (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY DATE(o.created_at)
    ORDER BY d ASC
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

  if (!title || title.length < 3) return res.status(400).redirect("/admin/contests?err=title");
  if (!Number.isFinite(price) || price < 0) return res.status(400).redirect("/admin/contests?err=price");

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
  const status = norm(req.query.status || "all");
  const bookOption = norm(req.query.book_option || "all");
  const contestId = norm(req.query.contest_id || "");
  const userName = norm(req.query.user_name || "");
  const phone = norm(req.query.phone || "");
  const orderId = norm(req.query.order_id || "");
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");
  const onDate = norm(req.query.on_date || "");

  const where: string[] = [onlineOrdersWhere("o"), `COALESCE(o.payment_id, '') LIKE 'KNC%'`];
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
    where.push(`u.phone ILIKE $${params.length + 1}`);
    params.push(normLike(phone));
  }
  if (orderId) {
    where.push(`(
      o.payment_id ILIKE $${params.length + 1}
      OR o.id::text ILIKE $${params.length + 1}
      OR o.payment_session_id::text ILIKE $${params.length + 1}
    )`);
    params.push(normLike(orderId));
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
  return {
    whereSql,
    params,
    filters: { status, bookOption, contestId, userName, phone, orderId, dateFrom, dateTo, onDate }
  };
}

async function facetOrdersCounts(req: any) {
  const mk = (overrides: any) => {
    const q2 = { ...req.query, ...overrides };
    const fakeReq = { query: q2 };
    return buildOrdersFilter(fakeReq);
  };

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
  const pageSize = 10;
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const offset = (page - 1) * pageSize;

  const listQ = await pool.query(
    `
    WITH filtered_orders AS (
      SELECT
        o.id,
        o.amount,
        o.payment_status,
        o.book_option,
        o.created_at,
        COALESCE(si.book_title, o.book_title) AS book_title,
        si.book_language,
        o.full_name,
        o.dob,
        o.payment_id,
        o.payment_session_id,
        u.id AS user_id,
        u.name AS user_name,
        u.email,
        u.phone,
        c.id AS contest_id,
        c.title AS contest_title,
        sh.id AS shipment_id,
        sh.delivery_mode,
        sh.status AS shipment_status,
        bonus.bonus_books
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN contests c ON c.id = o.contest_id
      LEFT JOIN shipment_items si ON si.order_id = o.id
      LEFT JOIN shipments sh ON sh.id = si.shipment_id
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(
          CASE
            WHEN COALESCE(sbi.quantity, 1) > 1
              THEN sbi.book_title || ' - ' || sbi.book_language || ' x' || sbi.quantity::text
            ELSE sbi.book_title || ' - ' || sbi.book_language
          END,
          ', '
          ORDER BY sbi.book_title, sbi.book_language
        ) AS bonus_books
        FROM shipment_bonus_items sbi
        WHERE sbi.shipment_id = sh.id
      ) bonus ON TRUE
      ${whereSql}
    )
    SELECT
      COALESCE(fo.payment_session_id::text, fo.payment_id) AS group_key,
      fo.payment_session_id,
      fo.payment_id AS order_group_id,
      fo.user_id,
      MAX(fo.user_name) AS user_name,
      MAX(fo.email) AS email,
      MAX(fo.phone) AS phone,
      MAX(fo.full_name) AS full_name,
      MIN(fo.created_at) AS created_at,
      COUNT(*)::int AS item_count,
      COALESCE(SUM(fo.amount), 0)::int AS total_amount,
      STRING_AGG(DISTINCT fo.payment_status, ', ' ORDER BY fo.payment_status) AS payment_statuses,
      STRING_AGG(DISTINCT fo.book_option, ', ' ORDER BY fo.book_option) AS book_options,
      STRING_AGG(DISTINCT fo.contest_title, ', ' ORDER BY fo.contest_title) AS contest_titles,
      STRING_AGG(DISTINCT fo.shipment_id::text, ', ' ORDER BY fo.shipment_id::text) FILTER (WHERE fo.shipment_id IS NOT NULL) AS shipment_ids,
      STRING_AGG(DISTINCT fo.delivery_mode, ', ' ORDER BY fo.delivery_mode) FILTER (WHERE COALESCE(fo.delivery_mode, '') <> '') AS delivery_modes,
      STRING_AGG(DISTINCT fo.shipment_status, ', ' ORDER BY fo.shipment_status) FILTER (WHERE COALESCE(fo.shipment_status, '') <> '') AS shipment_statuses,
      JSON_AGG(
        JSON_BUILD_OBJECT(
          'id', fo.id,
          'contest_title', fo.contest_title,
          'amount', fo.amount,
          'payment_status', fo.payment_status,
          'book_option', fo.book_option,
          'book_title', fo.book_title,
          'book_language', fo.book_language,
          'full_name', fo.full_name,
          'dob', fo.dob,
          'created_at', fo.created_at,
          'shipment_id', fo.shipment_id,
          'delivery_mode', fo.delivery_mode,
          'shipment_status', fo.shipment_status,
          'bonus_books', fo.bonus_books
        )
        ORDER BY fo.created_at DESC, fo.contest_title ASC, fo.id ASC
      ) AS items
    FROM filtered_orders fo
    GROUP BY COALESCE(fo.payment_session_id::text, fo.payment_id), fo.payment_session_id, fo.payment_id, fo.user_id
    ORDER BY MIN(fo.created_at) DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
    `,
    [...params, pageSize, offset]
  );

  const countQ = await pool.query(
    `
    WITH filtered_orders AS (
      SELECT
        o.user_id,
        o.payment_id,
        o.payment_session_id
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN contests c ON c.id = o.contest_id
      ${whereSql}
    )
    SELECT COUNT(*)::int AS c
    FROM (
      SELECT 1
      FROM filtered_orders fo
      GROUP BY COALESCE(fo.payment_session_id::text, fo.payment_id), fo.payment_session_id, fo.payment_id, fo.user_id
    ) x
    `,
    params
  );

  const totalItemsQ = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN contests c ON c.id = o.contest_id
    ${whereSql}
    `,
    params
  );

  const contestsQ = await pool.query(`SELECT id, title FROM contests ORDER BY title ASC`);
  const facets = await facetOrdersCounts(req);

  const orders = listQ.rows;
  const sessionIds = Array.from(new Set(
    orders.map((r: any) => String(r.payment_session_id || '').trim()).filter(Boolean)
  ));

  const reconcileMap: Record<string, any> = {};
  for (const paymentSessionId of sessionIds) {
    try {
      const preview = await buildReconcilePreviewBySessionId(paymentSessionId);
      reconcileMap[paymentSessionId] = preview || null;
    } catch (e: any) {
      reconcileMap[paymentSessionId] = {
        local: { payment_session_id: paymentSessionId, session_status: 'pending' },
        apiError: e?.message || 'Failed to fetch Razorpay payment details.',
        selectedPayment: null,
        decision: 'api_error',
        decisionLabel: 'API issue',
      };
    }
  }

  for (const group of orders as any[]) {
    const preview = group.payment_session_id ? reconcileMap[String(group.payment_session_id)] : null;
    group.reconcile = preview || null;
    group.our_status = String(preview?.local?.session_status || group.payment_statuses || '').trim() || '-';

    const razorpayDisplayStatus = (() => {
      const liveStatus = String(preview?.selectedPayment?.status || '').trim().toLowerCase();
      if (liveStatus) return liveStatus;

      const apiError = String(preview?.apiError || '').trim();
      if (apiError) return 'unavailable';

      if (!group.payment_session_id) return 'no_payment_session';

      const gatewayOrderId = String(preview?.local?.gateway_order_id || '').trim();
      if (!gatewayOrderId) return 'no_payment_id';

      return 'unavailable';
    })();

    group.razorpay_status = razorpayDisplayStatus;
    group.can_mark_failed =
      String(preview?.local?.session_status || '').toLowerCase() === 'pending' &&
      isFailedLikePaymentStatus(preview?.selectedPayment?.status);
  }

  const totalCount = Number(countQ.rows[0].c || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  res.render('admin/admin-orders', {
    activeTab: 'orders',
    orders,
    totalCount,
    totalItemCount: totalItemsQ.rows[0].c,
    contests: contestsQ.rows,
    filters,
    facets,
    page,
    pageSize,
    totalPages,
    reconcileMap,
    ok: norm(req.query.ok || ''),
    err: norm(req.query.err || ''),
    qs: qsOf(req),
    bulkReconcileBaseQs: qsOf({ query: { ...req.query, page: '' } } as any),
  });
});

router.post('/admin/orders/reconcile-failed-bulk/start', authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const fakeReq = { query: { ...req.body, ...req.query, status: 'pending', page: '1' } };
    const { whereSql, params } = buildOrdersFilter(fakeReq);

    const groupsQ = await pool.query(
      `
      WITH filtered_orders AS (
        SELECT
          o.user_id,
          o.payment_id,
          o.payment_session_id,
          o.created_at
        FROM orders o
        JOIN users u ON u.id = o.user_id
        JOIN contests c ON c.id = o.contest_id
        ${whereSql}
      )
      SELECT
        MIN(fo.payment_session_id::text) AS payment_session_id,
        MIN(fo.payment_id) AS order_group_id,
        MIN(fo.created_at) AS created_at
      FROM filtered_orders fo
      GROUP BY COALESCE(fo.payment_session_id::text, fo.payment_id), fo.payment_session_id, fo.payment_id, fo.user_id
      ORDER BY MIN(fo.created_at) DESC
      `,
      params
    );

    const groups = groupsQ.rows.map((r: any) => ({
      payment_session_id: r.payment_session_id,
      order_group_id: r.order_group_id,
    }));

    const job = createOrdersFailedReconcileJob(groups.length);

    if (groups.length === 0) {
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      return res.json({ ok: true, jobId: job.id, total: job.total });
    }

    void runOrdersFailedReconcileJob(job.id, groups, req.user?.id || null);
    return res.json({ ok: true, jobId: job.id, total: job.total });
  } catch (e: any) {
    console.error('admin orders bulk failed reconcile start error:', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to start bulk reconcile job' });
  }
});

router.get('/admin/orders/reconcile-failed-bulk/status/:jobId', authMiddleware, adminMiddleware, async (req: any, res) => {
  const job = ordersFailedReconcileJobs.get(String(req.params.jobId || ''));
  if (!job) {
    return res.status(404).json({ ok: false, message: 'Job not found' });
  }
  return res.json({ ok: true, job });
});

router.post('/admin/orders/reconcile-failed-page', authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.body.page || req.query.page || '1'), 10) || 1);
    const fakeReq = { query: { ...req.body, ...req.query, page: String(page) } };
    const { whereSql, params } = buildOrdersFilter(fakeReq);
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    const pageGroupsQ = await pool.query(
      `
      WITH filtered_orders AS (
        SELECT
          o.user_id,
          o.payment_id,
          o.payment_session_id,
          o.created_at
        FROM orders o
        JOIN users u ON u.id = o.user_id
        JOIN contests c ON c.id = o.contest_id
        ${whereSql}
      )
      SELECT
        fo.payment_session_id,
        MIN(fo.created_at) AS created_at
      FROM filtered_orders fo
      GROUP BY COALESCE(fo.payment_session_id::text, fo.payment_id), fo.payment_session_id, fo.payment_id, fo.user_id
      ORDER BY MIN(fo.created_at) DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    );

    let applied = 0;
    let skipped = 0;

    for (const row of pageGroupsQ.rows) {
      const paymentSessionId = String(row.payment_session_id || '').trim();
      if (!paymentSessionId) {
        skipped++;
        continue;
      }
      const result = await applyFailedForPendingSession({
        paymentSessionId,
        adminUserId: req.user?.id || null,
      });
      if (result.ok && result.updated) applied++;
      else skipped++;
    }

    const returnQs = qsOf(fakeReq as any);
    return res.redirect(`/admin/orders?${returnQs}&ok=${encodeURIComponent(`Failed reconcile complete. Updated: ${applied}. Skipped: ${skipped}.`)}`);
  } catch (e: any) {
    console.error('admin orders failed reconcile error:', e);
    const returnQs = qsOf({ query: { ...req.body, ...req.query } } as any);
    return res.redirect(`/admin/orders?${returnQs}&err=${encodeURIComponent(e?.message || 'Failed to reconcile current page')}`);
  }
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
  const locked = norm(req.query.locked || "all");
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

function buildShipmentFileName(prefix: string, ext = "xlsx") {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${stamp}.${ext}`;
}


function shipmentHeaderRow(extraFlag: "" | "PACKED_OR_NOT" | "DISPATCHED_OR_NOT" | "DELIVERED_OR_NOT" | "START_AGAIN" = "") {
  const headers = [
    "SHIPMENT_ID",
    "PAYMENT_ID",
    "USER_ID",
    "USER_NAME",
    "EMAIL",
    "PHONE",
    "CONTEST_TITLES",
    "REGULAR_BOOKS_WITH_LANGUAGE",
    "BONUS_BOOKS_WITH_LANGUAGE",
    "ALL_BOOKS_WITH_LANGUAGE",
    "ADDRESS",
    "CITY",
    "STATE",
    "PINCODE",
    "TRACKING_ID",
    "COURIER_MODE",
    "DELIVERY_MODE",
    "STATUS",
  ];

  if (extraFlag) headers.push(extraFlag);
  return headers;
}

function shipmentExportRows(
  rows: any[],
  statusOverride?: string,
  extraFlag: "" | "PACKED_OR_NOT" | "DISPATCHED_OR_NOT" | "DELIVERED_OR_NOT" | "START_AGAIN" = ""
) {
  return rows.map((r: any) => {
    const baseRow = [
      r.shipment_id || "",
      r.payment_id || "",
      r.user_id || "",
      r.user_name || "",
      r.email || "",
      r.phone || "",
      r.contest_titles || "",
      r.regular_books_with_language || "",
      r.bonus_books_with_language || "",
      r.books_display || "",
      r.address || "",
      r.city || "",
      r.state || "",
      r.pincode || "",
      r.tracking_id || "",
      r.courier_mode || "",
      r.delivery_mode || "",
      statusOverride || r.status || "",
    ];

    if (extraFlag) baseRow.push("");
    return baseRow;
  });
}

function shipmentWorkbookBuffer(
  rows: any[],
  statusOverride?: string,
  extraFlag: "" | "PACKED_OR_NOT" | "DISPATCHED_OR_NOT" | "DELIVERED_OR_NOT" | "START_AGAIN" = "",
  sheetName = "Shipments"
) {
  const header = shipmentHeaderRow(extraFlag);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    header,
    ...shipmentExportRows(rows, statusOverride, extraFlag),
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function sendShipmentWorkbook(
  res: any,
  filename: string,
  rows: any[],
  statusOverride?: string,
  extraFlag: "" | "PACKED_OR_NOT" | "DISPATCHED_OR_NOT" | "DELIVERED_OR_NOT" | "START_AGAIN" = "",
  sheetName = "Shipments"
) {
  const buffer = shipmentWorkbookBuffer(rows, statusOverride, extraFlag, sheetName);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(buffer);
}


function jsonOk(res: any, payload: any) {
  return res.status(200).json({ ok: true, ...payload });
}

function jsonBad(res: any, message: string, extra: any = {}) {
  return res.status(400).json({ ok: false, message, ...extra });
}

function buildShipmentsFilter(req: any) {
  const q = norm(req.query.q || "");
  const status = norm(req.query.status || "all");
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");
  const deliveryMode = norm(req.query.delivery_mode || "all");


  //const where: string[] = [`o.payment_status='paid'`, `o.book_option='book'`];

  const where: string[] = [
  `o.payment_status='paid'`,
  `o.book_option='book'`,
  shipmentsVisibleOrdersWhere("o")
];

  const params: any[] = [];

  if (q) {
    where.push(`(
      u.name ILIKE $${params.length + 1}
      OR u.phone ILIKE $${params.length + 1}
    )`);
    params.push(normLike(q));
  }

  if (status !== "all") {
    where.push(`COALESCE(LOWER(sh.status),'pending') = $${params.length + 1}`);
    params.push(status.toLowerCase());
  }

if (deliveryMode !== "all") {
  where.push(`COALESCE(LOWER(sh.delivery_mode), '') = $${params.length + 1}`);
  params.push(deliveryMode.toLowerCase());
}

  if (dateFrom) {
    where.push(`sh.updated_at >= $${params.length + 1}::date`);
    params.push(dateFrom);
  }

  if (dateTo) {
    where.push(`sh.updated_at < ($${params.length + 1}::date + INTERVAL '1 day')`);
    params.push(dateTo);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const page = Math.max(1, Number(req.query.page || 1));
  return {
    whereSql, params, filters: { q, status, dateFrom, dateTo, deliveryMode, page
    }
  };
}

router.get("/admin/shipments", authMiddleware, adminMiddleware, async (req: any, res) => {

  const effectiveQuery = {
  ...req.query,
  delivery_mode: norm(req.query.delivery_mode || "home_delivery"),
  page: Math.max(1, Number(req.query.page || 1)),
};

  const effectiveReq = { ...req, query: effectiveQuery };

  const { filters } = buildShipmentsFilter(effectiveReq);
  const shipmentPage = await fetchShipmentPageRows(effectiveReq);
  const contestsQ = await pool.query(`SELECT id, title FROM contests ORDER BY title ASC`);
  const tabStats = await fetchAllShipmentTabStats();

  const activeTab =
    filters.deliveryMode === "temple_pickup"
      ? "temple"
      : filters.deliveryMode === "all"
      ? "all"
      : "home";

  res.render("admin/admin-shipments", {
    activeTab: "shipments",
    items: shipmentPage.items,
page: shipmentPage.page,
pageSize: shipmentPage.pageSize,
totalCount: shipmentPage.totalCount,
totalPages: shipmentPage.totalPages,
    contests: contestsQ.rows,
    filters,
    shipmentTabStats: tabStats,
    selectedTab: activeTab,
    qs: qsOf(effectiveReq),
    imported: norm(req.query.imported || ""),
    errorMsg: norm(req.query.errorMsg || ""),
    okMsg: norm(req.query.okMsg || ""),
    rejectedFile: norm(req.query.rejectedFile || ""),
    validationErrors: [],
  });
});


router.get("/admin/shipments/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const rows = await fetchShipmentCsvRows(req);
  const filename = buildShipmentFileName("shipments_export");
  return sendShipmentWorkbook(res, filename, rows, undefined, "", "ShipmentsExport");
});


router.post("/admin/shipments/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const shipmentId = norm(req.body.shipmentId);
  const trackingId = norm(req.body.tracking_id);
  let courierMode = norm(req.body.courier_mode);
  let status = norm(req.body.status || "pending").toLowerCase();

  if (!shipmentId) return res.redirect("/admin/shipments");

  const allowedStatuses = new Set([
    "pending",
    "under_packing",
    "packed",
    "dispatched",
    "delivered",
    "handed_over",
    "returned",
  ]);

  if (!allowedStatuses.has(status)) status = "pending";

  const shipQ = await pool.query(
    `SELECT delivery_mode, courier_mode FROM shipments WHERE id=$1 LIMIT 1`,
    [shipmentId]
  );

  if (!shipQ.rows.length) {
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Shipment not found.")
    );
  }

  const deliveryMode = String(shipQ.rows[0]?.delivery_mode || "").toLowerCase();
  const existingCourier = norm(shipQ.rows[0]?.courier_mode || "");

  if (deliveryMode === "temple_pickup") {
    if (!["pending", "handed_over"].includes(status)) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Temple pickup supports only Pending or Handed Over.")
      );
    }
  } else {
    if (status === "handed_over") {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Home delivery cannot be marked Handed Over.")
      );
    }
  }

  if (status === "handed_over") {
    courierMode = courierMode || existingCourier || "temple_handover";
  } else if (status === "delivered") {
    courierMode = courierMode || existingCourier || "admin_marked_delivered";
  } else if (status === "dispatched") {
    courierMode = courierMode || existingCourier || "india_post";
  }

  await pool.query(
    `
    UPDATE shipments
    SET tracking_id=$1, courier_mode=$2, status=$3, updated_at=NOW()
    WHERE id=$4
    `,
    [trackingId || null, courierMode || null, status, shipmentId]
  );

  res.redirect("/admin/shipments?okMsg=" + encodeURIComponent("Shipment updated successfully."));
});

router.get(
  "/admin/shipments/export-missing-tracking",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const q = await pool.query(`
      SELECT
        sh.id AS shipment_id,
        u.name AS user_name,
        u.phone,
        sh.address,
        sh.city,
        sh.state,
        sh.pincode,

        STRING_AGG(
          DISTINCT (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, '')),
          ', '
        ) AS books_with_language

      FROM shipments sh
      JOIN shipment_items si ON si.shipment_id = sh.id
      JOIN orders o ON o.id = si.order_id
      JOIN users u ON u.id = o.user_id

      WHERE
        LOWER(sh.status) = 'pending'
        AND (sh.tracking_id IS NULL OR TRIM(sh.tracking_id) = '')

      GROUP BY
        sh.id, u.name, u.phone,
        sh.address, sh.city, sh.state, sh.pincode
      ORDER BY sh.id
    `);

    const rows = q.rows;

    const header = [
      "shipment_id",
      "user_name",
      "phone",
      "address",
      "city",
      "state",
      "pincode",
      "books_with_language",
      "tracking_id"
    ];

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      header,
      ...rows.map((r: any) => [
        r.shipment_id || "",
        r.user_name || "",
        r.phone || "",
        r.address || "",
        r.city || "",
        r.state || "",
        r.pincode || "",
        r.books_with_language || "",
        "",
      ]),
    ]);

    XLSX.utils.book_append_sheet(workbook, worksheet, "MissingTracking");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${buildShipmentFileName("missing_tracking")}"`);
    res.send(buffer);
  }
);

router.get("/admin/shipments/download-dispatched", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const dateFrom = norm(req.query.date_from || "");
    const dateTo = norm(req.query.date_to || "");

    if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Please select both From and To dates, or leave both blank to include all matching rows.")
      );
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Date range is invalid. From date cannot be after To date.")
      );
    }

    const forcedReq = {
      ...req,
      query: {
        ...req.query,
        status: "dispatched",
        delivery_mode: "home_delivery",
      },
    };

    const rows = await fetchShipmentCsvRows(forcedReq);
    const filename = buildShipmentFileName("shipments_dispatched_home_delivery");
    return sendShipmentWorkbook(res, filename, rows, undefined, "", "Dispatched");
  } catch (e) {
    console.error("download-dispatched error:", e);
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Failed to download dispatched home delivery shipments.")
    );
  }
});

router.post(
  "/admin/shipments/import-csv",
  authMiddleware,
  adminMiddleware,
  upload.single("result_file"),
  async (req: any, res) => {
    try {
      if (!req.file?.path) {
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Please choose an Excel file (.xlsx or .xls)."));
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Excel file is empty."));
      }

      const requiredColumns = [
        "SHIPMENT_ID",
        "USER_NAME",
        "PHONE",
        "ADDRESS",
        "REGULAR_BOOKS_WITH_LANGUAGE",
        "BONUS_BOOKS_WITH_LANGUAGE",
        "TRACKING_ID",
      ];

      const missingCols = requiredColumns.filter((c) => !(c in rows[0]));
      if (missingCols.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Missing required columns: " + missingCols.join(", "))
        );
      }

      const shipmentIds = rows
        .map((r) => normalizeCell(r["SHIPMENT_ID"]))
        .filter(Boolean);

      if (!shipmentIds.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("No shipment ids found in Excel file."));
      }

      const dbQ = await pool.query(
        `
        SELECT
          sh.id AS shipment_id,
          sh.payment_id,
          u.name AS user_name,
          u.email,
          u.phone,
          sh.address,
          sh.city,
          sh.state,
          sh.pincode,
          sh.tracking_id,
          sh.courier_mode,
          sh.status,

          STRING_AGG(
            (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, '')),
            ', ' ORDER BY (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, ''))
          ) AS regular_books_with_language,

          bonus.bonus_books_with_language

        FROM shipments sh
        JOIN shipment_items si ON si.shipment_id = sh.id
        JOIN orders o ON o.id = si.order_id
        JOIN users u ON u.id = o.user_id

        LEFT JOIN LATERAL (
          SELECT
            STRING_AGG(
              (COALESCE(sbi.book_title, '') || '-' || COALESCE(sbi.book_language, '')),
              ', ' ORDER BY (COALESCE(sbi.book_title, '') || '-' || COALESCE(sbi.book_language, ''))
            ) AS bonus_books_with_language
          FROM shipment_bonus_items sbi
          WHERE sbi.shipment_id = sh.id
        ) bonus ON TRUE

        WHERE sh.id = ANY($1::uuid[])
  AND o.payment_status = 'paid'
  AND o.book_option = 'book'
  AND LOWER(COALESCE(sh.delivery_mode,'')) = 'home_delivery'

        GROUP BY
          sh.id, sh.payment_id, u.name, u.email, u.phone,
          sh.address, sh.city, sh.state, sh.pincode,
          sh.tracking_id, sh.courier_mode, sh.status,
          bonus.bonus_books_with_language
        `,
        [shipmentIds]
      );

      const dbMap = new Map<string, any>();
      for (const r of dbQ.rows) {
        dbMap.set(String(r.shipment_id), {
          ...r,
          all_books_with_language: buildShipmentBooksLabel(
            r.regular_books_with_language,
            r.bonus_books_with_language
          ),
        });
      }

     const errors: string[] = [];
const validRows: any[] = [];
let skippedBlankTracking = 0;

for (let i = 0; i < rows.length; i++) {
  const rowNo = i + 2;
  const row = rows[i];

  const shipmentId = normalizeCell(row["SHIPMENT_ID"]);
  const userName = normalizeCell(row["USER_NAME"]);
  const phone = normalizeCell(row["PHONE"]);
  const address = normalizeCell(row["ADDRESS"]);
  const regularBooks = normalizeCell(row["REGULAR_BOOKS_WITH_LANGUAGE"]);
  const bonusBooks = normalizeCell(row["BONUS_BOOKS_WITH_LANGUAGE"]);
  const trackingId = normalizeCell(row["TRACKING_ID"]);
  const courierMode = normalizeCell(row["COURIER_MODE"]) || "excel_upload";

  if (!shipmentId) {
    errors.push(`Row ${rowNo}: SHIPMENT_ID is empty`);
    continue;
  }

  // skip rows not yet filled by packing team
  if (!trackingId) {
    skippedBlankTracking++;
    continue;
  }

  const dbRow = dbMap.get(shipmentId);
  if (!dbRow) {
    errors.push(`Row ${rowNo}: shipment ${shipmentId} not found among paid home-delivery shipments`);
    continue;
  }

  if (normalizeCompare(dbRow.user_name) !== normalizeCompare(userName)) {
    errors.push(`Row ${rowNo}: user name mismatch for shipment ${shipmentId}`);
  }

  if (normalizeCompare(dbRow.phone) !== normalizeCompare(phone)) {
    errors.push(`Row ${rowNo}: phone mismatch for shipment ${shipmentId}`);
  }

  if (normalizeCompare(dbRow.address) !== normalizeCompare(address)) {
    errors.push(`Row ${rowNo}: address mismatch for shipment ${shipmentId}`);
  }

  if (normalizeCompare(dbRow.regular_books_with_language) !== normalizeCompare(regularBooks)) {
    errors.push(`Row ${rowNo}: regular books mismatch for shipment ${shipmentId}`);
  }

  if (normalizeCompare(dbRow.bonus_books_with_language) !== normalizeCompare(bonusBooks)) {
    errors.push(`Row ${rowNo}: bonus books mismatch for shipment ${shipmentId}`);
  }

  validRows.push({
    shipmentId,
    trackingId,
    courierMode,
  });
}


   if (!validRows.length) {
  fs.unlink(req.file.path, () => {});
  return res.redirect(
    "/admin/shipments?errorMsg=" +
      encodeURIComponent("Excel validation failed: " + errors.slice(0, 12).join(" | "))
  );
}

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const r of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = $2,
              status = CASE
                WHEN LOWER(COALESCE(status,'')) IN ('delivered','handed_over') THEN status
                ELSE 'packed'
              END,
              updated_at = NOW()
            WHERE id = $3
            `,
            [r.trackingId, r.courierMode, r.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      const parts = [`Updated ${validRows.length} shipments.`];
if (errors.length) {
  parts.push(`Skipped ${errors.length} invalid rows.`);
}

return res.redirect(
  "/admin/shipments?okMsg=" + encodeURIComponent(parts.join(" ")) +
  (errors.length
    ? "&errorMsg=" + encodeURIComponent("Skipped rows: " + errors.slice(0, 12).join(" | "))
    : "")
);

    } catch (e) {
      console.error("shipments import-csv error:", e);
      return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Failed to import shipment Excel file."));
    }
  }
);


router.post(
  "/admin/shipments/import-tracking-temp",
  authMiddleware,
  adminMiddleware,
  upload.single("result_file"),
  async (req: any, res) => {
    try {
      if (!req.file?.path) {
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Please choose an Excel file (.xlsx or .xls).")
        );
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Uploaded file is empty.")
        );
      }

      const firstRow = rows[0] || {};

      const shipmentKey =
        "SHIPMENT_ID" in firstRow
          ? "SHIPMENT_ID"
          : "shipment_id" in firstRow
          ? "shipment_id"
          : "";

      const trackingKey =
        "TRACKING_ID" in firstRow
          ? "TRACKING_ID"
          : "tracking_id" in firstRow
          ? "tracking_id"
          : "";

      if (!shipmentKey || !trackingKey) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent(
              "Missing required columns. Expected shipment_id/SHIPMENT_ID and tracking_id/TRACKING_ID."
            )
        );
      }

      const parsedRows: { rowNo: number; shipmentId: string; trackingId: string }[] = [];
      const errors: string[] = [];
      let skippedBlankTracking = 0;

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];

        const shipmentId = normalizeCell(row[shipmentKey]);
        const trackingId = normalizeCell(row[trackingKey]);

        if (!shipmentId) {
          errors.push(`Row ${rowNo}: shipment id is empty`);
          continue;
        }

        // packing team may leave some rows blank; skip them
        if (!trackingId) {
          skippedBlankTracking++;
          continue;
        }

        parsedRows.push({ rowNo, shipmentId, trackingId });
      }

      if (errors.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Import failed: " + errors.slice(0, 12).join(" | "))
        );
      }

      const shipmentIds = Array.from(new Set(parsedRows.map((r) => r.shipmentId)));

      if (!shipmentIds.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("No shipment ids with tracking ids found in file.")
        );
      }

      const dbQ = await pool.query(
        `
        SELECT id, status, courier_mode
        FROM shipments
        WHERE id = ANY($1::uuid[])
        `,
        [shipmentIds]
      );

      const dbMap = new Map<string, any>();
      for (const r of dbQ.rows) {
        dbMap.set(String(r.id), r);
      }

      const validRows: { shipmentId: string; trackingId: string; courierMode: string }[] = [];

      for (const r of parsedRows) {
        const dbRow = dbMap.get(r.shipmentId);

        if (!dbRow) {
          errors.push(`Row ${r.rowNo}: shipment ${r.shipmentId} not found`);
          continue;
        }

        validRows.push({
          shipmentId: r.shipmentId,
          trackingId: r.trackingId,
          courierMode: normalizeCell(dbRow.courier_mode) || "india_post",
        });
      }

      if (errors.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Import failed: " + errors.slice(0, 12).join(" | "))
        );
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const r of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = $2,
              status = CASE
                WHEN LOWER(COALESCE(status, '')) IN ('delivered', 'handed_over') THEN status
                ELSE 'packed'
              END,
              updated_at = NOW()
            WHERE id = $3
            `,
            [r.trackingId, r.courierMode, r.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      const msg =
        `Temp tracking import successful. Updated ${validRows.length} shipments.` +
        (skippedBlankTracking ? ` Skipped ${skippedBlankTracking} blank tracking rows.` : "");

      return res.redirect(
        "/admin/shipments?okMsg=" + encodeURIComponent(msg)
      );
    } catch (e) {
      console.error("shipments import-tracking-temp error:", e);
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Failed to import temp tracking file.")
      );
    }
  }
);

// --------------------
// USERS 360 (mega view)
// --------------------
router.get("/admin/user360", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const live = norm(req.query.live || "0");

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
    SELECT
      sh.id AS shipment_id,
      COALESCE(sh.order_id, (ARRAY_AGG(o.id ORDER BY o.created_at ASC))[1]) AS order_id,
      sh.payment_id,
      sh.delivery_mode,
      sh.recipient_name,
      sh.recipient_phone,
      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.status,
      sh.updated_at,
      MIN(o.payment_status) AS payment_status,
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles,
      STRING_AGG(
        DISTINCT COALESCE(si.book_title, o.book_title, ''),
        ', ' ORDER BY COALESCE(si.book_title, o.book_title, '')
      ) AS book_titles
    FROM shipments sh
    LEFT JOIN shipment_items si ON si.shipment_id = sh.id
    LEFT JOIN orders o
      ON o.id = si.order_id
      OR (si.order_id IS NULL AND sh.order_id = o.id)
    LEFT JOIN contests c ON c.id = o.contest_id
    WHERE o.user_id = $1
      AND o.book_option = 'book'
      AND o.payment_status = 'paid'
    GROUP BY
      sh.id, sh.order_id, sh.payment_id, sh.delivery_mode,
      sh.recipient_name, sh.recipient_phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at
    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
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

  const paymentGroups = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    WHERE ps.user_id=$1
    GROUP BY ps.id, ps.payment_id, ps.status, ps.amount, ps.created_at
    ORDER BY ps.created_at DESC
    LIMIT 200
    `,
    [userId]
  );

  const reconcileSessionId = norm(req.query.reconcile_session || "");
  const reconcilePreview = reconcileSessionId
    ? await buildUser360ReconcilePreview(userId, reconcileSessionId)
    : null;

  res.render("admin/admin-user360-detail", {
    activeTab: "user360",
    user: u.rows[0],
    orders: orders.rows,
    shipments: shipments.rows,
    submissions: submissions.rows,
    feedback: feedback.rows,
    paymentGroups: paymentGroups.rows,
    reconcilePreview,
    okMsg: norm(req.query.ok || ""),
    errMsg: norm(req.query.err || ""),
  });
});

router.post("/admin/user360/:userId/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);

  const name = norm(req.body.name);
  const phone = norm(req.body.phone);
  const address = norm(req.body.address);
  const city = norm(req.body.city);
  const state = norm(req.body.state);
  const pincode = norm(req.body.pincode);

  await pool.query(
    `
    UPDATE users
    SET name=$1, phone=$2, address=$3, city=$4, state=$5, pincode=$6
    WHERE id=$7
    `,
    [name || null, phone || null, address || null, city || null, state || null, pincode || null, userId]
  );

  res.redirect(`/admin/user360/${userId}`);
});

router.post("/admin/user360/:userId/shipments/mark-delivered", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const shipmentId = norm(req.body.shipmentId);

  if (!shipmentId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Shipment id missing")}`);
  }

  const shipQ = await pool.query(
    `
    SELECT
      sh.id,
      COALESCE(LOWER(sh.status), 'pending') AS shipment_status,
      sh.courier_mode,
      MIN(o.payment_status) AS payment_status
    FROM shipments sh
    LEFT JOIN shipment_items si ON si.shipment_id = sh.id
    LEFT JOIN orders o
      ON o.id = si.order_id
      OR (si.order_id IS NULL AND sh.order_id = o.id)
    WHERE sh.id = $1
      AND o.user_id = $2
      AND o.book_option = 'book'
    GROUP BY sh.id, sh.status, sh.courier_mode
    LIMIT 1
    `,
    [shipmentId, userId]
  );

  if (!shipQ.rows.length) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Shipment not found for this user")}`);
  }

  const paymentStatus = String(shipQ.rows[0].payment_status || "").toLowerCase();
  const shipmentStatus = String(shipQ.rows[0].shipment_status || "pending").toLowerCase();

  if (paymentStatus !== "paid") {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Cannot hand over shipment for unpaid or pending order")}`);
  }

  if (shipmentStatus !== "pending") {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent(`Cannot hand over shipment because it is already ${shipmentStatus}`)}`);
  }

  await pool.query(
    `
    UPDATE shipments
    SET
      status = 'handed_over',
      updated_at = NOW()
    WHERE id = $1
    `,
    [shipmentId]
  );

  return res.redirect(`/admin/user360/${userId}?ok=${encodeURIComponent("Shipment marked handed over")}`);
});



router.post("/admin/user360/:userId/feedback/close", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const id = norm(req.body.id);
  if (!id) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Ticket id missing")}`);
  }

  await pool.query(
    `UPDATE feedback_tickets SET status='closed', closed_at=NOW() WHERE id=$1 AND user_id=$2`,
    [id, userId]
  );

  return res.redirect(`/admin/user360/${userId}?ok=${encodeURIComponent("Ticket closed")}`);
});

router.post("/admin/user360/:userId/payments/reconcile-preview", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const paymentSessionId = norm(req.body.paymentSessionId);
  if (!paymentSessionId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session missing")}`);
  }
  return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}`);
});

router.post("/admin/user360/:userId/payments/apply-paid", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const paymentSessionId = norm(req.body.paymentSessionId);
  if (!paymentSessionId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session missing")}`);
  }

  const preview = await buildUser360ReconcilePreview(userId, paymentSessionId);

  if (!preview || !preview.local) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session not found")}`);
  }

  if (String(preview.local.session_status || "").toLowerCase() === "paid") {
    return res.redirect(
      `/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("This payment session is already marked paid")}`
    );
  }

  if (!preview.canApplyPaid) {
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("Razorpay has not confirmed a captured payment with amount at least equal to local amount")}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`,
      [paymentSessionId]
    );
    await client.query(
      `UPDATE orders SET payment_status='paid' WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [paymentSessionId]
    );
    await client.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        paymentSessionId,
        "admin_reconcile_apply",
        JSON.stringify({
          paymentSessionId,
          gatewayOrderId: preview.local.gateway_order_id,
          internalPaymentId: preview.local.internal_payment_id,
          razorpayPaymentId: preview.selectedPayment?.id || null,
          razorpayStatus: preview.selectedPayment?.status || null,
          amountMatches: preview.amountMatches,
          amountAtLeastExpected: !!preview.amountAtLeastExpected,
          expectedAmount: Number(preview.local.session_amount || 0),
          capturedAmount: Number(preview.capturedAmount || 0),
          overCollectedAmount: Number(preview.overCollectedAmount || 0),
          decision: String(preview.decision || "unknown"),
          adminUserId: userId,
          at: new Date().toISOString(),
        }),
      ]
    );

    await client.query("COMMIT");
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&ok=${encodeURIComponent("Payment reconciled and marked paid")}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("admin user360 reconcile apply error:", e);
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("Failed to apply paid status")}`);
  } finally {
    client.release();
  }
});


type BulkLocalRow = {
  payment_session_id: string;
  user_id: string;
  user_name: string;
  email: string;
  phone: string;
  gateway_order_id: string;
  internal_payment_id: string;
  session_status: string;
  session_amount: number;
  created_at: string;
  order_count: number;
  order_statuses: string;
};

async function getBulkReconcileLocalPage(filters: BulkReconcileFilters) {
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(10, Math.min(200, Number(filters.pageSize || 50)));
  const offset = (page - 1) * pageSize;

  const base = buildBulkReconcileBaseSql(filters);

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM payment_sessions ps
    JOIN users u ON u.id = ps.user_id
    ${base.whereSql}
    `,
    base.params
  );

  const rowsQ = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.user_id,
      u.name AS user_name,
      u.email,
      u.phone,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    JOIN users u ON u.id = ps.user_id
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    ${base.whereSql}
    GROUP BY
      ps.id, ps.user_id, u.name, u.email, u.phone,
      ps.payment_id, ps.status, ps.amount, ps.created_at
    ORDER BY ps.created_at DESC
    LIMIT $${base.params.length + 1}
    OFFSET $${base.params.length + 2}
    `,
    [...base.params, pageSize, offset]
  );

  return {
    total: Number(countQ.rows[0]?.total || 0),
    page,
    pageSize,
    rows: rowsQ.rows as BulkLocalRow[],
  };
}

type ReconcileCacheSnapshot = {
  selectedPayment: any;
  payments: any[];
  apiError: string;
  amountMatches: boolean;
  amountAtLeastExpected: boolean;
  canApplyPaid: boolean;
  razorpayEnabled: boolean;
  capturedAmount: number;
  capturedAmountPaise: number;
  expectedAmountPaise: number;
  overCollectedAmount: number;
  underpaidAmount: number;
  isHigherAmount: boolean;
  decision: BulkDecision;
  decisionLabel: string;
};

async function getLatestReconcileCache(paymentSessionId: string, maxAgeMinutes = 15) {
  const q = await pool.query(
    `
    SELECT payload, created_at
    FROM payment_gateway_logs
    WHERE payment_session_id = $1
      AND event = 'bulk_reconcile_snapshot'
      AND created_at >= NOW() - ($2 || ' minutes')::interval
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [paymentSessionId, String(maxAgeMinutes)]
  );

  if (!q.rows.length) return null;
  return q.rows[0].payload || null;
}

async function saveReconcileCache(paymentSessionId: string, payload: any) {
  await pool.query(
    `
    INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
    VALUES ($1, 'bulk_reconcile_snapshot', $2::jsonb)
    `,
    [paymentSessionId, JSON.stringify(payload)]
  );
}

async function buildPreviewFromLocalRow(row: BulkLocalRow): Promise<ReconcileCacheSnapshot> {
  const expectedAmountPaise = Math.round(Number(row.session_amount || 0) * 100);
  const gatewayOrderId = String(row.gateway_order_id || "");

  const cached = await getLatestReconcileCache(String(row.payment_session_id), 15);
  if (cached) return cached as ReconcileCacheSnapshot;

  const preview: ReconcileCacheSnapshot = {
    selectedPayment: null,
    payments: [],
    apiError: "",
    amountMatches: false,
    amountAtLeastExpected: false,
    canApplyPaid: false,
    razorpayEnabled: hasRzpEnv(),
    capturedAmountPaise: 0,
    capturedAmount: 0,
    expectedAmountPaise,
    overCollectedAmount: 0,
    underpaidAmount: 0,
    isHigherAmount: false,
    decision: "unknown",
    decisionLabel: "Review manually",
  };

  if (!preview.razorpayEnabled) {
    preview.apiError = "Razorpay keys are not configured on this server.";
    preview.decision = "api_error";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  if (!gatewayOrderId) {
    preview.apiError = "Gateway order id not found on payment session.";
    preview.decision = "api_error";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  if (gatewayOrderId.startsWith("DEV_")) {
    preview.apiError = "Skipped DEV payment session.";
    preview.decision = "skipped_dev";
    preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;
    return preview;
  }

  try {
    const resp = await rzpRequest<RzpOrderPaymentsResp>(
      "GET",
      `/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`
    );

    const payments = Array.isArray(resp?.items) ? resp.items : [];
    preview.payments = payments;

    const sorted = payments.slice().sort((a, b) => {
      const rank = (p: any) => {
        const st = String(p?.status || "").toLowerCase();
        if (st === "captured") return 3;
        if (st === "authorized") return 2;
        if (st === "created") return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (rb !== ra) return rb - ra;
      return Number(b?.created_at || 0) - Number(a?.created_at || 0);
    });

    const selected = sorted[0] || null;
    preview.selectedPayment = selected;
    preview.capturedAmountPaise = Number(selected?.amount || 0);
    preview.capturedAmount = preview.capturedAmountPaise / 100;
    preview.amountMatches = !!selected && preview.capturedAmountPaise === expectedAmountPaise;
    preview.amountAtLeastExpected = !!selected && preview.capturedAmountPaise >= expectedAmountPaise;
    preview.isHigherAmount = !!selected && preview.capturedAmountPaise > expectedAmountPaise;
    preview.overCollectedAmount = Math.max(0, (preview.capturedAmountPaise - expectedAmountPaise) / 100);
    preview.underpaidAmount = Math.max(0, (expectedAmountPaise - preview.capturedAmountPaise) / 100);
    preview.canApplyPaid =
      !!selected &&
      String(selected.status || "").toLowerCase() === "captured" &&
      preview.amountAtLeastExpected;
  } catch (e: any) {
    preview.apiError = e?.message || "Failed to fetch Razorpay payment details.";
  }

 preview.decision = classifyBulkDecision({
    sessionStatus: row.session_status,
    apiError: preview.apiError,
    gatewayOrderId,
    selectedPayment: preview.selectedPayment,
    expectedAmountPaise,
  });
  preview.decisionLabel = getBulkDecisionMeta(preview.decision).label;

  // Hard safeguard: if already paid locally, never treat as recoverable/actionable
  if (String(row.session_status || "").toLowerCase() === "paid") {
    preview.canApplyPaid = false;
    preview.decision = "local_paid";
    preview.decisionLabel = getBulkDecisionMeta("local_paid").label;
  }
  try {
    await saveReconcileCache(String(row.payment_session_id), preview);
  } catch (e) {
    console.error("save reconcile cache failed:", e);
  }

  return preview;

}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true)    {
      const current = nextIndex++;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

async function buildBulkReconcileRowsForPage(filters: BulkReconcileFilters): Promise<{
  rows: BulkReconcileRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const localPage = await getBulkReconcileLocalPage(filters);

  const previews = await mapWithConcurrency(
    localPage.rows,
    6, // 5 or 6 is safe
    async (row) => buildPreviewFromLocalRow(row)
  );

  const rows: BulkReconcileRow[] = localPage.rows.map((row, idx) => {
    const preview = previews[idx];
    return {
      ...row,
      selectedPayment: preview.selectedPayment || null,
      payments: preview.payments || [],
      apiError: preview.apiError || "",
      amountMatches: !!preview.amountMatches,
      amountAtLeastExpected: !!preview.amountAtLeastExpected,
      canApplyPaid: !!preview.canApplyPaid,
      razorpayEnabled: !!preview.razorpayEnabled,
      capturedAmount: Number(preview.capturedAmount || 0),
      capturedAmountPaise: Number(preview.capturedAmountPaise || 0),
      expectedAmountPaise: Number(preview.expectedAmountPaise || 0),
      overCollectedAmount: Number(preview.overCollectedAmount || 0),
      underpaidAmount: Number(preview.underpaidAmount || 0),
      isHigherAmount: !!preview.isHigherAmount,
      decision: preview.decision,
      decisionLabel: preview.decisionLabel,
    };
  });

  return {
    rows,
    total: localPage.total,
    page: localPage.page,
    pageSize: localPage.pageSize,
  };
}

router.get("/admin/payments/reconcile-bulk", authMiddleware, adminMiddleware, async (req: any, res) => {
  const filters: BulkReconcileFilters = {
    localStatus: norm(req.query.local_status || "all"),
    decision: norm(req.query.decision || "all"),
    q: norm(req.query.q || ""),
    scanAll: String(req.query.scan_all || "0") === "1",
    page: Math.max(1, Number(req.query.page || 1)),
    pageSize: Math.max(10, Math.min(200, Number(req.query.page_size || 50))),
  };

  const currentDbRevenue = await getCurrentDbPaidRevenue();

  const pageData = await buildBulkReconcileRowsForPage(filters);
  let pageRows = pageData.rows;

  const decision = String(filters.decision || "all");
  pageRows = filterBulkRowsByDecision(pageRows, decision);

  pageRows.sort((a, b) => {
    const ra = getBulkDecisionMeta(a.decision).sortRank;
    const rb = getBulkDecisionMeta(b.decision).sortRank;
    if (ra !== rb) return ra - rb;
    return Number(new Date(String(b.created_at || 0))) - Number(new Date(String(a.created_at || 0)));
  });

  const pager = {
    total: pageData.total,
    pageCount: Math.max(1, Math.ceil(pageData.total / pageData.pageSize)),
    currentPage: pageData.page,
    pageSize: pageData.pageSize,
    items: pageRows,
  };

  const summary = summarizeBulkRows(pageRows, currentDbRevenue);

  res.render("admin/admin-bulk-reconcile", {
    activeTab: "bulk-reconcile",
    rows: pageRows,
    pager,
    summary,
    filters,
    scannedCount: pageRows.length,
    filteredCount: pageRows.length,
    qs: bulkQueryString(filters),
    okMsg: norm(req.query.ok || ""),
    errMsg: norm(req.query.err || ""),
  });
});


router.post("/admin/payments/reconcile-bulk/apply-selected", authMiddleware, adminMiddleware, async (req: any, res) => {
  const raw = req.body.payment_session_ids;
  const sessionIds = Array.isArray(raw) ? raw.map((x: any) => norm(x)).filter(Boolean) : raw ? [norm(raw)] : [];
  const returnQs = norm(req.body.return_qs || "scan=1&scan_all=1");

  if (!sessionIds.length) {
    return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&err=${encodeURIComponent("Please select at least one payment session")}`);
  }

  let applied = 0;
  let skipped = 0;
  const reasons: string[] = [];

  for (const paymentSessionId of sessionIds) {
    const result = await applyPaidForSessionFromPreview({
      paymentSessionId,
      adminActor: String(req.userId || "admin"),
    });

    if (result.ok) applied++;
    else {
      skipped++;
      reasons.push(`${paymentSessionId}: ${result.reason}`);
    }
  }

  const msg =
    `Bulk reconcile complete. Applied: ${applied}. Skipped: ${skipped}.` +
    (reasons.length ? ` First issues: ${reasons.slice(0, 5).join(" | ")}` : "");

  return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&ok=${encodeURIComponent(msg)}`);
});

router.post("/admin/payments/reconcile-bulk/reconcile-send-selected", authMiddleware, adminMiddleware, async (req: any, res) => {
  const raw = req.body.payment_session_ids;
  const sessionIds = Array.isArray(raw) ? raw.map((x: any) => norm(x)).filter(Boolean) : raw ? [norm(raw)] : [];
  const returnQs = norm(req.body.return_qs || "scan=1&scan_all=1");

  if (!sessionIds.length) {
    return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&err=${encodeURIComponent("Please select at least one payment session")}`);
  }

  let applied = 0;
  let sent = 0;
  let messageSkipped = 0;
  let messageFailed = 0;
  let skipped = 0;
  const reasons: string[] = [];

  for (const paymentSessionId of sessionIds) {
    const result = await reconcileSessionAndMaybeSend({
      paymentSessionId,
      adminActor: String(req.userId || "admin"),
      sendMessage: true,
    });

    if (!result.ok) {
      skipped++;
      reasons.push(`${paymentSessionId}: ${result.reconcile?.reason || "reconcile_failed"}`);
      continue;
    }

    applied++;

    if (result.message) {
      if (result.message.ok && !result.message.skipped) sent++;
      else if (result.message.skipped) messageSkipped++;
      else messageFailed++;
    }
  }

  const msg =
    `Reconcile + send complete. Applied: ${applied}. Sent: ${sent}. Message skipped: ${messageSkipped}. Message failed: ${messageFailed}. Reconcile skipped: ${skipped}.` +
    (reasons.length ? ` First issues: ${reasons.slice(0, 5).join(" | ")}` : "");

  return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&ok=${encodeURIComponent(msg)}`);
});

router.post("/admin/payments/reconcile-bulk/reconcile-send-one", authMiddleware, adminMiddleware, async (req: any, res) => {
  const paymentSessionId = norm(req.body.payment_session_id);
  const returnQs = norm(req.body.return_qs || "scan=1&scan_all=1");

  if (!paymentSessionId) {
    return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&err=${encodeURIComponent("Payment session missing")}`);
  }

  const result = await reconcileSessionAndMaybeSend({
    paymentSessionId,
    adminActor: String(req.userId || "admin"),
    sendMessage: true,
  });

  if (!result.ok) {
    return res.redirect(
      `/admin/payments/reconcile-bulk?${returnQs}&err=${encodeURIComponent(`Failed for ${paymentSessionId}: ${result.reconcile?.reason || "reconcile_failed"}`)}`
    );
  }

  let msg = `Reconciled ${paymentSessionId}.`;
  if (result.message) {
    if (result.message.ok && !result.message.skipped) msg += " WhatsApp sent.";
    else if (result.message.skipped) msg += ` WhatsApp skipped (${result.message.reason || "already_sent"}).`;
    else msg += ` WhatsApp failed (${result.message.reason || "send_failed"}).`;
  }

  return res.redirect(`/admin/payments/reconcile-bulk?${returnQs}&ok=${encodeURIComponent(msg)}`);
});

router.post("/admin/payments/reconcile-bulk/apply-filtered-safe", authMiddleware, adminMiddleware, async (req: any, res) => {
  const filters: BulkReconcileFilters = {
    localStatus: norm(req.body.local_status || "all"),
    decision: norm(req.body.decision || "all"),
    q: norm(req.body.q || ""),
    scanAll: false,
    page: Math.max(1, Number(req.body.page || 1)),
    pageSize: Math.max(10, Math.min(200, Number(req.body.page_size || 50))),
  };

  const returnQs = bulkQueryString(filters);
  const pageData = await buildBulkReconcileRowsForPage(filters);
  const decision = String(filters.decision || "all");
  const filteredRows = filterBulkRowsByDecision(pageData.rows, decision);
  const safeRows = filteredRows.filter((r) => r.canApplyPaid);

  let applied = 0;
  let skipped = 0;

  for (const row of safeRows) {
    const result = await applyPaidForSessionFromPreview({
      paymentSessionId: String(row.payment_session_id),
      adminActor: String(req.userId || "admin"),
    });

    if (result.ok) applied++;
    else skipped++;
  }

  return res.redirect(
    `/admin/payments/reconcile-bulk?${returnQs}&ok=${encodeURIComponent(
      `Apply-current-page-safe complete. Applied: ${applied}. Skipped: ${skipped}.`
    )}`
  );
});

router.post("/admin/payments/reconcile-bulk/reconcile-send-filtered-safe", authMiddleware, adminMiddleware, async (req: any, res) => {
  const filters: BulkReconcileFilters = {
    localStatus: norm(req.body.local_status || "all"),
    decision: norm(req.body.decision || "all"),
    q: norm(req.body.q || ""),
    scanAll: false,
    page: Math.max(1, Number(req.body.page || 1)),
    pageSize: Math.max(10, Math.min(200, Number(req.body.page_size || 50))),
  };

  const returnQs = bulkQueryString(filters);
  const pageData = await buildBulkReconcileRowsForPage(filters);
  const decision = String(filters.decision || "all");
  const filteredRows = filterBulkRowsByDecision(pageData.rows, decision);
  const safeRows = filteredRows.filter((r) => r.canApplyPaid);

  let applied = 0;
  let sent = 0;
  let messageSkipped = 0;
  let messageFailed = 0;
  let skipped = 0;

  for (const row of safeRows) {
    const result = await reconcileSessionAndMaybeSend({
      paymentSessionId: String(row.payment_session_id),
      adminActor: String(req.userId || "admin"),
      sendMessage: true,
    });

    if (!result.ok) {
      skipped++;
      continue;
    }

    applied++;

    if (result.message) {
      if (result.message.ok && !result.message.skipped) sent++;
      else if (result.message.skipped) messageSkipped++;
      else messageFailed++;
    }
  }

  return res.redirect(
    `/admin/payments/reconcile-bulk?${returnQs}&ok=${encodeURIComponent(
      `Reconcile + send current-page safe complete. Applied: ${applied}. Sent: ${sent}. Message skipped: ${messageSkipped}. Message failed: ${messageFailed}. Reconcile skipped: ${skipped}.`
    )}`
  );
});


// --------------------
// USERS FILTERING
// --------------------

function usersQueryString(input: any) {
  const sp = new URLSearchParams();

  const q = norm(input.q || "");
  const paymentBucket = norm(input.payment_bucket || "all");
  const disposition = norm(input.disposition || "all");
  const page = Math.max(1, toInt(input.page, 1));
  const pageSize = Math.max(10, Math.min(200, toInt(input.page_size, 50)));

  if (q) sp.set("q", q);
  if (paymentBucket && paymentBucket !== "all") sp.set("payment_bucket", paymentBucket);
  if (disposition && disposition !== "all") sp.set("disposition", disposition);
  if (page > 1) sp.set("page", String(page));
  if (pageSize !== 50) sp.set("page_size", String(pageSize));

  return sp.toString();
}

function classifyDispositionLabel(v: string) {
  const x = String(v || "").trim().toLowerCase();
  switch (x) {
    case "interested": return "Interested";
    case "likely_later": return "Likely later";
    case "payment_issue": return "Payment issue";
    case "needs_callback": return "Needs callback";
    case "not_interested": return "Not interested";
    case "wrong_number": return "Wrong number";
    case "no_response": return "No response";
    case "already_joined": return "Already joined";
    case "information_only": return "Information only";
    default: return x || "-";
  }
}

function buildUsersFilter(req: any) {
  const q = norm(req.query.q || "");
  const paymentBucket = norm(req.query.payment_bucket || "all").toLowerCase();
  const disposition = norm(req.query.disposition || "all").toLowerCase();
  const page = Math.max(1, toInt(req.query.page, 1));
  const pageSize = Math.max(10, Math.min(200, toInt(req.query.page_size, 50)));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: any[] = [];

  if (q) {
    where.push(`(
      ur.name ILIKE $${params.length + 1}
      OR ur.email ILIKE $${params.length + 1}
      OR ur.phone ILIKE $${params.length + 1}
      OR CAST(ur.id AS text) ILIKE $${params.length + 1}
    )`);
    params.push(normLike(q));
  }

  if (paymentBucket !== "all") {
    if (paymentBucket === "paid") {
      where.push(`ur.payment_bucket = $${params.length + 1}`);
      params.push("paid");
    } else if (paymentBucket === "added_to_cart") {
      where.push(`ur.payment_bucket = $${params.length + 1}`);
      params.push("added_to_cart");
    } else if (paymentBucket === "registered_only") {
      where.push(`ur.payment_bucket = $${params.length + 1}`);
      params.push("registered_only");
    }
  }

  if (disposition !== "all") {
    if (disposition === "none") {
      where.push(`COALESCE(ur.latest_disposition, '') = ''`);
    } else {
      where.push(`COALESCE(ur.latest_disposition, '') = $${params.length + 1}`);
      params.push(disposition);
    }
  }

  return {
    q,
    paymentBucket,
    disposition,
    page,
    pageSize,
    offset,
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    qsBase: usersQueryString({
      q,
      payment_bucket: paymentBucket,
      disposition,
      page_size: pageSize,
    }),
  };
}

function getUsersRollupCte() {
  return `
    WITH user_rollup AS (
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.created_at,

        COALESCE(oa.total_orders, 0) AS total_orders,
        COALESCE(oa.paid_orders, 0) AS paid_orders,
        COALESCE(oa.pending_orders, 0) AS pending_orders,

        COALESCE(psa.total_payment_sessions, 0) AS total_payment_sessions,
        COALESCE(psa.paid_sessions, 0) AS paid_sessions,
        psa.last_payment_attempt_at,

        CASE
          WHEN COALESCE(oa.paid_orders, 0) > 0 OR COALESCE(psa.paid_sessions, 0) > 0 THEN 'paid'
          WHEN COALESCE(oa.total_orders, 0) > 0 THEN 'added_to_cart'
          ELSE 'registered_only'
        END AS payment_bucket,

        f.latest_followup_id,
        f.latest_disposition,
        f.latest_sub_disposition,
        f.latest_notes,
        f.latest_callback_on,
        f.latest_followup_at,
        COALESCE(f.followup_count, 0) AS followup_count

      FROM users u

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(o.payment_status, '')) = 'paid'
          )::int AS paid_orders,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(o.payment_status, 'pending')) <> 'paid'
          )::int AS pending_orders
        FROM orders o
        WHERE o.user_id = u.id
      ) oa ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total_payment_sessions,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(ps.status, '')) = 'paid'
          )::int AS paid_sessions,
          MAX(ps.created_at) AS last_payment_attempt_at
        FROM payment_sessions ps
        WHERE ps.user_id = u.id
      ) psa ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          lf.id AS latest_followup_id,
          lf.disposition AS latest_disposition,
          lf.sub_disposition AS latest_sub_disposition,
          lf.notes AS latest_notes,
          lf.callback_on AS latest_callback_on,
          lf.created_at AS latest_followup_at,
          cnt.followup_count
        FROM user_followup_logs lf
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS followup_count
          FROM user_followup_logs x
          WHERE x.user_id = u.id
        ) cnt
        WHERE lf.user_id = u.id
        ORDER BY lf.created_at DESC, lf.id DESC
        LIMIT 1
      ) f ON TRUE
    )
  `;
}


function buildUsersJourney(row: any) {
  const bucket = String(row.payment_bucket || "");
  if (bucket === "paid") return "Paid successfully";
  if (bucket === "added_to_cart") return "Added to cart";
  return "Registered only";
}


// --------------------
// USERS
// --------------------
// USERS 360 (mega view)
// --------------------
router.get("/admin/user360", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const live = norm(req.query.live || "0");

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
    SELECT
      sh.id AS shipment_id,
      COALESCE(sh.order_id, (ARRAY_AGG(o.id ORDER BY o.created_at ASC))[1]) AS order_id,
      sh.payment_id,
      sh.delivery_mode,
      sh.recipient_name,
      sh.recipient_phone,
      sh.address,
      sh.city,
      sh.state,
      sh.pincode,
      sh.tracking_id,
      sh.courier_mode,
      sh.status,
      sh.updated_at,
      MIN(o.payment_status) AS payment_status,
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles,
      STRING_AGG(
        DISTINCT COALESCE(si.book_title, o.book_title, ''),
        ', ' ORDER BY COALESCE(si.book_title, o.book_title, '')
      ) AS book_titles
    FROM shipments sh
    LEFT JOIN shipment_items si ON si.shipment_id = sh.id
    LEFT JOIN orders o
      ON o.id = si.order_id
      OR (si.order_id IS NULL AND sh.order_id = o.id)
    LEFT JOIN contests c ON c.id = o.contest_id
    WHERE o.user_id = $1
      AND o.book_option = 'book'
      AND o.payment_status = 'paid'
    GROUP BY
      sh.id, sh.order_id, sh.payment_id, sh.delivery_mode,
      sh.recipient_name, sh.recipient_phone,
      sh.address, sh.city, sh.state, sh.pincode,
      sh.tracking_id, sh.courier_mode, sh.status, sh.updated_at
    ORDER BY sh.updated_at DESC NULLS LAST, sh.id DESC
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

  const paymentGroups = await pool.query(
    `
    SELECT
      ps.id AS payment_session_id,
      ps.payment_id AS gateway_order_id,
      ps.status AS session_status,
      ps.amount AS session_amount,
      ps.created_at,
      MIN(o.payment_id) AS internal_payment_id,
      COUNT(o.id)::int AS order_count,
      STRING_AGG(DISTINCT o.payment_status, ', ' ORDER BY o.payment_status) AS order_statuses
    FROM payment_sessions ps
    LEFT JOIN orders o ON o.payment_session_id = ps.id
    WHERE ps.user_id=$1
    GROUP BY ps.id, ps.payment_id, ps.status, ps.amount, ps.created_at
    ORDER BY ps.created_at DESC
    LIMIT 200
    `,
    [userId]
  );

  const reconcileSessionId = norm(req.query.reconcile_session || "");
  const reconcilePreview = reconcileSessionId
    ? await buildUser360ReconcilePreview(userId, reconcileSessionId)
    : null;

  res.render("admin/admin-user360-detail", {
    activeTab: "user360",
    user: u.rows[0],
    orders: orders.rows,
    shipments: shipments.rows,
    submissions: submissions.rows,
    feedback: feedback.rows,
    paymentGroups: paymentGroups.rows,
    reconcilePreview,
    okMsg: norm(req.query.ok || ""),
    errMsg: norm(req.query.err || ""),
  });
});

router.post("/admin/user360/:userId/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);

  const name = norm(req.body.name);
  const phone = norm(req.body.phone);
  const address = norm(req.body.address);
  const city = norm(req.body.city);
  const state = norm(req.body.state);
  const pincode = norm(req.body.pincode);

  await pool.query(
    `
    UPDATE users
    SET name=$1, phone=$2, address=$3, city=$4, state=$5, pincode=$6
    WHERE id=$7
    `,
    [name || null, phone || null, address || null, city || null, state || null, pincode || null, userId]
  );

  res.redirect(`/admin/user360/${userId}`);
});

router.post("/admin/user360/:userId/shipments/mark-delivered", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const shipmentId = norm(req.body.shipmentId);
  if (!shipmentId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Shipment id missing")}`);
  }

  const shipQ = await pool.query(
    `
    SELECT
      sh.id,
      sh.delivery_mode,
      sh.courier_mode,
      MIN(o.payment_status) AS payment_status
    FROM shipments sh
    LEFT JOIN shipment_items si ON si.shipment_id = sh.id
    LEFT JOIN orders o
      ON o.id = si.order_id
      OR (si.order_id IS NULL AND sh.order_id = o.id)
    WHERE sh.id = $1
      AND o.user_id = $2
      AND o.book_option = 'book'
    GROUP BY sh.id, sh.delivery_mode, sh.courier_mode
    LIMIT 1
    `,
    [shipmentId, userId]
  );

  if (!shipQ.rows.length) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Shipment not found for this user")}`);
  }

  if (String(shipQ.rows[0].payment_status || "").toLowerCase() !== "paid") {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Cannot hand over shipment for unpaid or pending order")}`);
  }

  const deliveryMode = String(shipQ.rows[0].delivery_mode || "");
  const existingCourier = norm(shipQ.rows[0].courier_mode || "");
  const fallbackCourier =
    deliveryMode === "temple_pickup"
      ? (existingCourier || "temple_handover")
      : (existingCourier || "admin_marked_delivered");

  await pool.query(
    `
    UPDATE shipments
    SET
      status = 'delivered',
      courier_mode = COALESCE(NULLIF($1,''), courier_mode),
      updated_at = NOW()
    WHERE id = $2
    `,
    [fallbackCourier, shipmentId]
  );

  return res.redirect(`/admin/user360/${userId}?ok=${encodeURIComponent("Shipment marked delivered")}`);
});

router.post("/admin/user360/:userId/feedback/close", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const id = norm(req.body.id);
  if (!id) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Ticket id missing")}`);
  }

  await pool.query(
    `UPDATE feedback_tickets SET status='closed', closed_at=NOW() WHERE id=$1 AND user_id=$2`,
    [id, userId]
  );

  return res.redirect(`/admin/user360/${userId}?ok=${encodeURIComponent("Ticket closed")}`);
});

router.post("/admin/user360/:userId/payments/reconcile-preview", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const paymentSessionId = norm(req.body.paymentSessionId);
  if (!paymentSessionId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session missing")}`);
  }
  return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}`);
});

router.post("/admin/user360/:userId/payments/apply-paid", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);
  const paymentSessionId = norm(req.body.paymentSessionId);
  if (!paymentSessionId) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session missing")}`);
  }

  const preview = await buildUser360ReconcilePreview(userId, paymentSessionId);

  if (!preview || !preview.local) {
    return res.redirect(`/admin/user360/${userId}?err=${encodeURIComponent("Payment session not found")}`);
  }

  if (String(preview.local.session_status || "").toLowerCase() === "paid") {
    return res.redirect(
      `/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("This payment session is already marked paid")}`
    );
  }

  if (!preview.canApplyPaid) {
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("Razorpay has not confirmed a captured payment with amount at least equal to local amount")}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE payment_sessions SET status='paid' WHERE id=$1 AND status <> 'paid'`,
      [paymentSessionId]
    );
    await client.query(
      `UPDATE orders SET payment_status='paid' WHERE payment_session_id=$1 AND payment_status <> 'paid'`,
      [paymentSessionId]
    );
    await client.query(
      `INSERT INTO payment_gateway_logs (payment_session_id, event, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        paymentSessionId,
        "admin_reconcile_apply",
        JSON.stringify({
          paymentSessionId,
          gatewayOrderId: preview.local.gateway_order_id,
          internalPaymentId: preview.local.internal_payment_id,
          razorpayPaymentId: preview.selectedPayment?.id || null,
          razorpayStatus: preview.selectedPayment?.status || null,
          amountMatches: preview.amountMatches,
          adminUserId: userId,
          at: new Date().toISOString(),
        }),
      ]
    );

    await client.query("COMMIT");
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&ok=${encodeURIComponent("Payment reconciled and marked paid")}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("admin user360 reconcile apply error:", e);
    return res.redirect(`/admin/user360/${userId}?reconcile_session=${encodeURIComponent(paymentSessionId)}&err=${encodeURIComponent("Failed to apply paid status")}`);
  } finally {
    client.release();
  }
});


// --------------------
// USERS
// --------------------
router.get("/admin/users", authMiddleware, adminMiddleware, async (req: any, res) => {
  const base = buildUsersFilter(req);

  const listQ = await pool.query(
    `
    ${getUsersRollupCte()}
    SELECT *
    FROM user_rollup ur
    ${base.whereSql}
    ORDER BY COALESCE(ur.last_payment_attempt_at, ur.created_at) DESC, ur.created_at DESC
    LIMIT $${base.params.length + 1}
    OFFSET $${base.params.length + 2}
    `,
    [...base.params, base.pageSize, base.offset]
  );

  const countQ = await pool.query(
    `
    ${getUsersRollupCte()}
    SELECT COUNT(*)::int AS total_count
    FROM user_rollup ur
    ${base.whereSql}
    `,
    base.params
  );

const facetQ = await pool.query(
    `
    ${getUsersRollupCte()}
    SELECT
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (WHERE payment_bucket = 'paid')::int AS paid_count,
      COUNT(*) FILTER (WHERE payment_bucket = 'added_to_cart')::int AS added_to_cart_count,
      COUNT(*) FILTER (WHERE payment_bucket = 'registered_only')::int AS registered_only_count,
      COUNT(*) FILTER (WHERE COALESCE(latest_disposition, '') = '')::int AS no_followup_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'interested')::int AS interested_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'likely_later')::int AS likely_later_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'payment_issue')::int AS payment_issue_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'needs_callback')::int AS needs_callback_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'not_interested')::int AS not_interested_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'wrong_number')::int AS wrong_number_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'no_response')::int AS no_response_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'already_joined')::int AS already_joined_count,
      COUNT(*) FILTER (WHERE latest_disposition = 'information_only')::int AS information_only_count
    FROM user_rollup ur
    `
  );

  const users = listQ.rows.map((u: any) => ({
    ...u,
    journey_label: buildUsersJourney(u),
    latest_disposition_label: classifyDispositionLabel(u.latest_disposition || ""),
  }));

  const totalCount = Number(countQ.rows?.[0]?.total_count || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / base.pageSize));
  const page = Math.min(base.page, totalPages);
  const startIndex = totalCount === 0 ? 0 : (base.offset + 1);
  const endIndex = Math.min(base.offset + base.pageSize, totalCount);

  res.render("admin/admin-users", {
    activeTab: "users",
    users,
    q: base.q,
    paymentBucket: base.paymentBucket,
    disposition: base.disposition,
    counts: facetQ.rows[0] || {},
    totalCount,
    totalPages,
    page,
    pageSize: base.pageSize,
    startIndex,
    endIndex,
    qs: qsOf(req),
    qsBase: base.qsBase,
    okMsg: norm(req.query.ok || ""),
    errMsg: norm(req.query.err || ""),
    openFollowupUserId: norm(req.query.followup_user_id || ""),
  });
});

router.get("/admin/users/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const base = buildUsersFilter(req);

  const q = await pool.query(
    `
    ${getUsersRollupCte()}
    SELECT *
    FROM user_rollup ur
    ${base.whereSql}
    ORDER BY COALESCE(ur.last_payment_attempt_at, ur.created_at) DESC, ur.created_at DESC
    LIMIT 10000
    `,
    base.params
  );

   const headers = [
    "id",
    "name",
    "email",
    "phone",
    "created_at",
    "payment_bucket",
    "journey",
    "last_payment_attempt_at",
    "latest_disposition",
    "latest_sub_disposition",
    "latest_notes",
    "latest_callback_on",
    "latest_followup_at",
    "followup_count"
  ];

  const rows = q.rows.map((u: any) => [
    u.id,
    u.name,
    u.email,
    u.phone,
    u.created_at,
    u.payment_bucket,
    buildUsersJourney(u),
    u.last_payment_attempt_at,
    u.latest_disposition,
    u.latest_sub_disposition,
    u.latest_notes,
    u.latest_callback_on,
    u.latest_followup_at,
    u.followup_count
  ]);

  return sendCsv(res, "users_export.csv", headers, rows);
});

router.get("/admin/users/:userId/followups", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.params.userId);

  const userQ = await pool.query(
    `
    SELECT id, name, email, phone, created_at
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (!userQ.rows.length) {
    return res.status(404).json({ ok: false, error: "User not found" });
  }

  const historyQ = await pool.query(
    `
    SELECT
      l.id,
      l.user_id,
      l.disposition,
      l.sub_disposition,
      l.notes,
      l.callback_on,
      l.created_at,
      cu.name AS created_by_name
    FROM user_followup_logs l
    LEFT JOIN users cu ON cu.id = l.created_by
    WHERE l.user_id = $1
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 100
    `,
    [userId]
  );

  return res.json({
    ok: true,
    user: userQ.rows[0],
    items: historyQ.rows,
  });
});

router.post("/admin/users/followups/add", authMiddleware, adminMiddleware, async (req: any, res) => {
  const userId = norm(req.body.user_id);
  const disposition = norm(req.body.disposition).toLowerCase();
  const subDisposition = norm(req.body.sub_disposition || "");
  const notes = norm(req.body.notes || "");
  const callbackOn = norm(req.body.callback_on || "");
  const returnQs = norm(req.body.return_qs || "");

  const allowed = new Set([
    "interested",
    "likely_later",
    "payment_issue",
    "needs_callback",
    "not_interested",
    "wrong_number",
    "no_response",
    "already_joined",
    "information_only",
  ]);

  if (!userId) {
    return res.redirect(`/admin/users?${returnQs}&err=${encodeURIComponent("User id missing")}`);
  }

  if (!allowed.has(disposition)) {
    return res.redirect(`/admin/users?${returnQs}&err=${encodeURIComponent("Please choose a valid disposition")}`);
  }

  const userQ = await pool.query(`SELECT id FROM users WHERE id=$1 LIMIT 1`, [userId]);
  if (!userQ.rows.length) {
    return res.redirect(`/admin/users?${returnQs}&err=${encodeURIComponent("User not found")}`);
  }

  await pool.query(
    `
    INSERT INTO user_followup_logs (
      user_id,
      disposition,
      sub_disposition,
      notes,
      callback_on,
      created_by
    )
    VALUES ($1, $2, $3, $4, NULLIF($5,'')::timestamptz, $6)
    `,
    [userId, disposition, subDisposition || null, notes || null, callbackOn || "", req.user?.id || null]
  );

  return res.redirect(`/admin/users?${returnQs}&ok=${encodeURIComponent("Follow-up saved")}&followup_user_id=${encodeURIComponent(userId)}`);
});

// --------------------
// FEEDBACK (admin view)
// --------------------
router.get("/admin/feedback", authMiddleware, adminMiddleware, async (req: any, res) => {
  const base = buildFeedbackFilter(req);
  const countsBase = buildFeedbackFilter({ query: { ...req.query, status: "all" } });

  const q = await pool.query(
    `
    SELECT
      f.id, f.user_id, f.message, f.status, f.created_at, f.closed_at,
      u.name AS user_name, u.email, u.phone,
      wml.status AS reply_status,
      wml.created_at AS reply_created_at,
      wml.provider_message_id AS reply_provider_message_id,
      wml.response_text AS reply_response_text
    FROM feedback_tickets f
    LEFT JOIN users u ON u.id=f.user_id
    LEFT JOIN LATERAL (
      SELECT status, created_at, provider_message_id, response_text
      FROM whatsapp_message_logs
      WHERE payment_id = ('FB-' || CAST(f.id AS text))
        AND message_type = 'feedback_reply'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) wml ON true
    ${base.whereSql}
    ORDER BY f.created_at DESC
    LIMIT 300
    `,
    base.params
  );

  const countsQ = await pool.query(
    `
    SELECT
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(f.status,'open'))='open')::int AS open_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(f.status,'open'))='closed')::int AS closed_count
    FROM feedback_tickets f
    LEFT JOIN users u ON u.id=f.user_id
    ${countsBase.whereSql}
    `,
    countsBase.params
  );

  res.render("admin/admin-feedback", {
    activeTab: "feedback",
    items: q.rows,
    status: base.status,
    q: base.q,
    counts: countsQ.rows[0] || { all_count: 0, open_count: 0, closed_count: 0 },
    okMsg: norm(req.query.ok || ""),
    errMsg: norm(req.query.err || ""),
    qs: qsOf(req),
  });
});

router.get("/admin/feedback/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const base = buildFeedbackFilter(req);

  const q = await pool.query(
    `
    SELECT
      f.id, f.user_id, f.message, f.status, f.created_at, f.closed_at,
      u.name AS user_name, u.email, u.phone,
      wml.status AS reply_status,
      wml.created_at AS reply_created_at
    FROM feedback_tickets f
    LEFT JOIN users u ON u.id=f.user_id
    LEFT JOIN LATERAL (
      SELECT status, created_at
      FROM whatsapp_message_logs
      WHERE payment_id = ('FB-' || CAST(f.id AS text))
        AND message_type = 'feedback_reply'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) wml ON true
    ${base.whereSql}
    ORDER BY f.created_at DESC
    LIMIT 5000
    `,
    base.params
  );

  const headers = ["ticket_id","user_id","user_name","email","phone","message","status","created_at","closed_at","reply_status","reply_created_at"];
  const rows = q.rows.map((t: any) => [t.id,t.user_id,t.user_name,t.email,t.phone,t.message,t.status,t.created_at,t.closed_at,t.reply_status,t.reply_created_at]);
  return sendCsv(res, "feedback_export.csv", headers, rows);
});

router.post("/admin/feedback/close", authMiddleware, adminMiddleware, async (req: any, res) => {
  const id = norm(req.body.id);
  const returnQs = norm(req.body.return_qs || feedbackQueryString({
    status: norm(req.body.status || "open"),
    q: norm(req.body.q || ""),
  }));

  if (!id) {
    return res.redirect(`/admin/feedback?${returnQs}`);
  }

  await pool.query(
    `UPDATE feedback_tickets SET status='closed', closed_at=NOW() WHERE id=$1`,
    [id]
  );
  return res.redirect(`/admin/feedback?${returnQs}&ok=${encodeURIComponent("Ticket closed")}`);
});

router.post("/admin/feedback/send-message", authMiddleware, adminMiddleware, async (req: any, res) => {
  const ticketId = norm(req.body.ticketId);
  const userId = norm(req.body.userId);
  const message = norm(req.body.message);
  const returnQs = norm(req.body.return_qs || feedbackQueryString({
    status: norm(req.body.status || "open"),
    q: norm(req.body.q || ""),
  }));

  if (!userId) {
    return res.redirect(`/admin/feedback?${returnQs}&err=${encodeURIComponent("User id missing")}`);
  }

  if (!message || message.length < 2) {
    return res.redirect(`/admin/feedback?${returnQs}&err=${encodeURIComponent("Please enter a message to send")}`);
  }

  const userQ = await pool.query(
    `
    SELECT id, name, phone
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (!userQ.rows.length) {
    return res.redirect(`/admin/feedback?${returnQs}&err=${encodeURIComponent("User not found")}`);
  }

  const user = userQ.rows[0];
  const phone = normPhone10(user.phone);

  if (!phone) {
    return res.redirect(`/admin/feedback?${returnQs}&err=${encodeURIComponent("User phone number not found")}`);
  }

  const sendResult = await sendAdminFeedbackReply({
    userId,
    ticketId,
    phone,
    userName: String(user.name || "Participant"),
    message,
  });

  if (!sendResult.ok) {
    const reason =
      sendResult.reason === "provider_not_configured"
        ? "WhatsApp provider is not configured for admin feedback replies"
        : sendResult.reason === "missing_required_fields"
        ? "Missing phone or message"
        : `Failed to send WhatsApp message${sendResult.reason ? `: ${sendResult.reason}` : ""}`;

    return res.redirect(`/admin/feedback?${returnQs}&err=${encodeURIComponent(reason)}`);
  }

  return res.redirect(`/admin/feedback?${returnQs}&ok=${encodeURIComponent("WhatsApp message sent successfully")}`);
});

// --------------------
// ADMIN UPLOAD ON BEHALF (SUBMISSIONS)
// --------------------
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

// ===================== SHIPMENT STOCK (FINAL CLEAN) =====================

// ===================== SHIPMENT STOCK (FINAL CLEAN) =====================

const SHIPMENT_STOCK_LANGUAGES = ["Telugu", "English", "Hindi", "Tamil", "Kannada"];

const MAIN_STOCK_BOOKS = [
  "Bhagavad Gita",
  "Krishna Book",
  "Ramayana",
  "Bhagavatam",
];

const BONUS_STOCK_BOOKS = [
  "Science of Self Realization",
];

function normalizeLang(v: any) {
  const x = String(v || "").trim().toLowerCase();
  if (x === "telugu") return "Telugu";
  if (x === "english") return "English";
  if (x === "hindi") return "Hindi";
  if (x === "tamil") return "Tamil";
  if (x === "kannada") return "Kannada";
  return "";
}

async function getUnifiedShipmentStockAnalytics() {
  const q = await pool.query(
    `
    WITH paid_shipments AS (
      SELECT DISTINCT
        sh.id,
        LOWER(COALESCE(sh.delivery_mode, '')) AS delivery_mode,
        LOWER(COALESCE(sh.status, 'pending')) AS status
      FROM shipments sh
      LEFT JOIN shipment_items si ON si.shipment_id = sh.id
      LEFT JOIN orders o ON o.id = si.order_id
      WHERE o.payment_status = 'paid'
      AND o.payment_id NOT LIKE 'AGT_%'
        AND o.book_option = 'book'
    ),

    catalog AS (
      SELECT 'main'::text AS item_type, b.book_title, l.book_language
      FROM UNNEST($1::text[]) AS b(book_title)
      CROSS JOIN UNNEST($2::text[]) AS l(book_language)

      UNION ALL

      SELECT 'bonus'::text AS item_type, b.book_title, l.book_language
      FROM UNNEST($3::text[]) AS b(book_title)
      CROSS JOIN UNNEST($2::text[]) AS l(book_language)
    ),

    main_demand AS (
      SELECT
        'main'::text AS item_type,
        TRIM(COALESCE(si.book_title, '')) AS book_title,
        INITCAP(TRIM(COALESCE(si.book_language, ''))) AS book_language,

        COUNT(*) FILTER (WHERE ps.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE ps.status = 'packed')::int AS packed,
        COUNT(*) FILTER (WHERE ps.status = 'dispatched')::int AS dispatched,
        COUNT(*) FILTER (WHERE ps.status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE ps.status = 'handed_over')::int AS handed_over

      FROM shipment_items si
      JOIN paid_shipments ps ON ps.id = si.shipment_id
      WHERE INITCAP(TRIM(COALESCE(si.book_language, ''))) = ANY($2::text[])
        AND TRIM(COALESCE(si.book_title, '')) <> ''
      GROUP BY 1, 2, 3
    ),

    bonus_demand AS (
      SELECT
        'bonus'::text AS item_type,
        TRIM(COALESCE(sbi.book_title, '')) AS book_title,
        INITCAP(TRIM(COALESCE(sbi.book_language, ''))) AS book_language,

        SUM(CASE WHEN ps.status = 'pending' THEN COALESCE(sbi.quantity, 1) ELSE 0 END)::int AS pending,
        SUM(CASE WHEN ps.status = 'packed' THEN COALESCE(sbi.quantity, 1) ELSE 0 END)::int AS packed,
        SUM(CASE WHEN ps.status = 'dispatched' THEN COALESCE(sbi.quantity, 1) ELSE 0 END)::int AS dispatched,
        SUM(CASE WHEN ps.status = 'delivered' THEN COALESCE(sbi.quantity, 1) ELSE 0 END)::int AS delivered,
        SUM(CASE WHEN ps.status = 'handed_over' THEN COALESCE(sbi.quantity, 1) ELSE 0 END)::int AS handed_over

      FROM shipment_bonus_items sbi
      JOIN paid_shipments ps ON ps.id = sbi.shipment_id
      WHERE INITCAP(TRIM(COALESCE(sbi.book_language, ''))) = ANY($2::text[])
        AND TRIM(COALESCE(sbi.book_title, '')) <> ''
      GROUP BY 1, 2, 3
    ),

    demand AS (
      SELECT * FROM main_demand
      UNION ALL
      SELECT * FROM bonus_demand
    ),

    stock AS (
      SELECT
        CASE
          WHEN LOWER(TRIM(book_title)) = LOWER('Science of Self Realization') THEN 'bonus'
          ELSE 'main'
        END AS item_type,
        TRIM(book_title) AS book_title,
        INITCAP(TRIM(book_language)) AS book_language,
        COALESCE(stock_qty, 0)::int AS stock_qty,
        COALESCE(notes, '') AS notes
      FROM shipment_book_stock
      WHERE INITCAP(TRIM(COALESCE(book_language, ''))) = ANY($2::text[])
    )

    SELECT
      c.item_type,
      c.book_title,
      c.book_language,

      COALESCE(s.stock_qty, 0) AS stock_qty,
      COALESCE(s.notes, '') AS notes,

      COALESCE(d.pending, 0) AS pending,
      COALESCE(d.packed, 0) AS packed,
      COALESCE(d.dispatched, 0) AS dispatched,
      COALESCE(d.delivered, 0) AS delivered,
      COALESCE(d.handed_over, 0) AS handed_over

    FROM catalog c
    LEFT JOIN demand d
      ON LOWER(d.item_type) = LOWER(c.item_type)
     AND LOWER(d.book_title) = LOWER(c.book_title)
     AND LOWER(d.book_language) = LOWER(c.book_language)
    LEFT JOIN stock s
      ON LOWER(s.item_type) = LOWER(c.item_type)
     AND LOWER(s.book_title) = LOWER(c.book_title)
     AND LOWER(s.book_language) = LOWER(c.book_language)

    ORDER BY c.book_language, c.item_type, c.book_title
    `,
    [MAIN_STOCK_BOOKS, SHIPMENT_STOCK_LANGUAGES, BONUS_STOCK_BOOKS]
  );

  const rows = q.rows.map((r: any) => {
    const stockQty = toInt(r.stock_qty);
    const pending = toInt(r.pending);
    const packed = toInt(r.packed);
    const dispatched = toInt(r.dispatched);
    const delivered = toInt(r.delivered);
    const handedOver = toInt(r.handed_over);

    const totalDemand = pending + packed + dispatched + delivered + handedOver;
    const availableAfterPending = stockQty - pending;
    const availableAfterPacked = stockQty - pending - packed;

    let stockState = "ok";
    if (stockQty === 0 || stockQty < pending) {
      stockState = "critical";
    } else if (stockQty < pending + packed) {
      stockState = "warning";
    }

    return {
      ...r,
      stock_qty: stockQty,
      pending,
      packed,
      dispatched,
      delivered,
      handed_over: handedOver,
      total_demand: totalDemand,
      available_after_pending: availableAfterPending,
      available_after_packed: availableAfterPacked,
      stock_state: stockState,
    };
  });

  const grouped: Record<string, any[]> = {};
  for (const lang of SHIPMENT_STOCK_LANGUAGES) grouped[lang] = [];

  rows.forEach((r: any) => {
    const lang = normalizeLang(r.book_language);
    if (!grouped[lang]) grouped[lang] = [];
    grouped[lang].push(r);
  });

  const summary = {
    trackedRows: rows.length,
    godownStock: rows.reduce((sum: number, r: any) => sum + Number(r.stock_qty || 0), 0),
    pendingToPack: rows.reduce((sum: number, r: any) => sum + Number(r.pending || 0), 0),
    packedAwaitingDispatch: rows.reduce((sum: number, r: any) => sum + Number(r.packed || 0), 0),
    criticalCount: rows.filter((r: any) => r.stock_state === "critical").length,
    outOfStockCount: rows.filter((r: any) => Number(r.stock_qty || 0) === 0).length,
  };

  return { rows, grouped, summary };
}

// ROUTE
router.get("/admin/shipment-stock", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const data = await getUnifiedShipmentStockAnalytics();

    return res.render("admin/admin-shipment-stock", {
      groupedRows: data.grouped,
      stockLanguages: SHIPMENT_STOCK_LANGUAGES,
      summary: data.summary,
      okMsg: req.query.ok || "",
      errMsg: req.query.err || "",
    });
  } catch (e) {
    console.error("shipment stock page error:", e);
    return res.status(500).send("Failed to load shipment stock page");
  }
});

// ADJUST STOCK
router.post("/admin/shipment-stock/adjust", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const bookTitle = norm(req.body.book_title);
    const bookLanguage = normalizeLang(req.body.book_language);
    const action = norm(req.body.action).toLowerCase(); // add | remove
    const adjustQty = Math.max(0, toInt(req.body.adjust_qty, 0));
    const notes = norm(req.body.notes);

    if (!bookTitle) {
      return res.redirect("/admin/shipment-stock?err=" + encodeURIComponent("Book title is required"));
    }

    if (!bookLanguage) {
      return res.redirect("/admin/shipment-stock?err=" + encodeURIComponent("Valid language is required"));
    }

    if (!["add", "remove"].includes(action)) {
      return res.redirect("/admin/shipment-stock?err=" + encodeURIComponent("Invalid stock action"));
    }

    if (adjustQty <= 0) {
      return res.redirect("/admin/shipment-stock?err=" + encodeURIComponent("Adjustment quantity must be greater than 0"));
    }

    await pool.query(
      `
      INSERT INTO shipment_book_stock (book_title, book_language, stock_qty, notes, updated_at)
      VALUES ($1, $2, 0, NULL, NOW())
      ON CONFLICT (book_title, book_language) DO NOTHING
      `,
      [bookTitle, bookLanguage]
    );

    await pool.query(
      `
      UPDATE shipment_book_stock
      SET
        stock_qty = CASE
          WHEN $3 = 'add' THEN COALESCE(stock_qty, 0) + $4
          ELSE GREATEST(0, COALESCE(stock_qty, 0) - $4)
        END,
        notes = CASE
          WHEN NULLIF($5, '') IS NOT NULL THEN $5
          ELSE notes
        END,
        updated_at = NOW()
      WHERE book_title = $1
        AND book_language = $2
      `,
      [bookTitle, bookLanguage, action, adjustQty, notes || null]
    );

    const msg =
      action === "add"
        ? `${adjustQty} added to stock for ${bookTitle} - ${bookLanguage}`
        : `${adjustQty} removed from stock for ${bookTitle} - ${bookLanguage}`;

    return res.redirect("/admin/shipment-stock?ok=" + encodeURIComponent(msg));
  } catch (e) {
    console.error("shipment stock adjust error:", e);
    return res.redirect("/admin/shipment-stock?err=" + encodeURIComponent("Failed to adjust stock"));
  }
});


router.get("/admin/agent-bookings/user", authMiddleware, adminMiddleware, async (req, res) => {
  const phone = String(req.query.phone || "");

  if (!phone) return res.json({});

  const result = await pool.query(
    `SELECT id, name FROM users WHERE phone=$1 LIMIT 1`,
    [phone]
  );

  if (result.rows.length) {
    return res.json(result.rows[0]);
  }

  res.json({});
});

// ==============================
// AGENTS
// ==============================

const normPhone = (v: any) => String(v || "").replace(/\D/g, "").slice(-10);
const normName = (v: any) => String(v || "").trim().replace(/\s+/g, " ");
const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(String(v || "").trim());

router.get("/admin/agents", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const editId = norm(req.query.editId || "");

  const where: string[] = [`LOWER(COALESCE(u.role,'')) = 'agent'`];
  const params: any[] = [];

  if (q) {
    params.push(normLike(q));
    where.push(`(u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const agentsQ = await pool.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      u.role,
      u.created_at
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT 500
    `,
    params
  );

  let editAgent: any = null;
  if (editId) {
    const editQ = await pool.query(
      `
      SELECT id, name, phone, role, created_at
      FROM users
      WHERE id=$1 AND LOWER(COALESCE(role,''))='agent'
      LIMIT 1
      `,
      [editId]
    );
    editAgent = editQ.rows[0] || null;
  }

  return res.render("admin/admin-agents", {
    q,
    agents: agentsQ.rows,
    editAgent,
    okMsg: norm(req.query.okMsg || ""),
    errMsg: norm(req.query.errMsg || ""),
  });
});

router.post("/admin/agents/create", authMiddleware, adminMiddleware, async (req: any, res) => {
  const name = normName(req.body.name);
  const phone = normPhone(req.body.phone);

  if (!name || !phone) {
    return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Name and phone are required")}`);
  }

  if (!isValidIndianMobile(phone)) {
    return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Please enter a valid 10-digit Indian mobile number")}`);
  }

  try {
    const existingQ = await pool.query(
      `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
      [phone]
    );

    if (existingQ.rows.length) {
      return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Phone number already exists in users table")}`);
    }

    const hashedPassword = await hashPassword("agent123");

    await pool.query(
      `
      INSERT INTO users (name, phone, password_hash, role)
      VALUES ($1, $2, $3, 'agent')
      `,
      [name, phone, hashedPassword]
    );

    return res.redirect(`/admin/agents?okMsg=${encodeURIComponent("Agent created successfully")}`);
  } catch (e: any) {
    return res.redirect(`/admin/agents?errMsg=${encodeURIComponent(e.message || "Failed to create agent")}`);
  }
});

router.post(
  "/admin/agents/upload",
  authMiddleware,
  adminMiddleware,
  upload.single("file"),
  async (req: any, res) => {
    const client = await pool.connect();

    try {
      const filePath = req.file?.path;
      if (!filePath) {
        return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Please upload a CSV or XLSX file")}`);
      }

      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (!rows.length) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Uploaded file is empty")}`);
      }

      const hashedPassword = await hashPassword("agent123");

      let inserted = 0;
      let skipped = 0;
      const rowErrors: string[] = [];

      await client.query("BEGIN");

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};

        const name = normName(row.name || row.Name || row.NAME);
        const phone = normPhone(
          row.phone || row.Phone || row.PHONE || row.mobile || row.Mobile || row.MOBILE
        );

        if (!name && !phone) {
          skipped++;
          continue;
        }

        if (!name || !phone) {
          rowErrors.push(`Row ${i + 2}: name or phone missing`);
          continue;
        }

        if (!isValidIndianMobile(phone)) {
          rowErrors.push(`Row ${i + 2}: invalid phone number`);
          continue;
        }

        const existingQ = await client.query(
          `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
          [phone]
        );

        if (existingQ.rows.length) {
          skipped++;
          continue;
        }

        await client.query(
          `
          INSERT INTO users (name, phone, password_hash, role)
          VALUES ($1, $2, $3, 'agent')
          `,
          [name, phone, hashedPassword]
        );

        inserted++;
      }

      await client.query("COMMIT");

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      const msg =
        `Bulk upload completed. Inserted: ${inserted}, Skipped: ${skipped}` +
        (rowErrors.length ? `. Errors: ${rowErrors.slice(0, 5).join(" | ")}` : "");

      return res.redirect(`/admin/agents?okMsg=${encodeURIComponent(msg)}`);
    } catch (e: any) {
      await client.query("ROLLBACK");
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.redirect(`/admin/agents?errMsg=${encodeURIComponent(e.message || "Bulk upload failed")}`);
    } finally {
      client.release();
    }
  }
);

router.post("/admin/agents/:agentId/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const agentId = norm(req.params.agentId);
  const name = normName(req.body.name);
  const phone = normPhone(req.body.phone);

  if (!agentId) {
    return res.redirect(`/admin/agents?errMsg=${encodeURIComponent("Invalid agent id")}`);
  }

  if (!name || !phone) {
    return res.redirect(`/admin/agents?editId=${encodeURIComponent(agentId)}&errMsg=${encodeURIComponent("Name and phone are required")}`);
  }

  if (!isValidIndianMobile(phone)) {
    return res.redirect(`/admin/agents?editId=${encodeURIComponent(agentId)}&errMsg=${encodeURIComponent("Please enter a valid 10-digit Indian mobile number")}`);
  }

  try {
    const duplicateQ = await pool.query(
      `
      SELECT id
      FROM users
      WHERE phone=$1
        AND id <> $2
      LIMIT 1
      `,
      [phone, agentId]
    );

    if (duplicateQ.rows.length) {
      return res.redirect(`/admin/agents?editId=${encodeURIComponent(agentId)}&errMsg=${encodeURIComponent("Another user already uses this phone number")}`);
    }

    await pool.query(
      `
      UPDATE users
      SET name=$1,
          phone=$2,
          role='agent'
      WHERE id=$3
        AND LOWER(COALESCE(role,''))='agent'
      `,
      [name, phone, agentId]
    );

    return res.redirect(`/admin/agents?okMsg=${encodeURIComponent("Agent updated successfully")}`);
  } catch (e: any) {
    return res.redirect(`/admin/agents?editId=${encodeURIComponent(agentId)}&errMsg=${encodeURIComponent(e.message || "Failed to update agent")}`);
  }
});

router.get("/admin/offline-dashboard", authMiddleware, adminMiddleware, async (_req: any, res) => {
  const usersQ = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);

  const ordersAllQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${offlineOrdersWhere("o")}
  `);

  const paidOrdersQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${offlineOrdersWhere("o")} AND LOWER(COALESCE(o.payment_status,''))='paid'
  `);

  const pendingFailedQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${offlineOrdersWhere("o")}
      AND LOWER(COALESCE(o.payment_status,'pending')) IN ('pending','failed','failure','cancelled','canceled','error')
  `);

  const giftQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${offlineOrdersWhere("o")}
      AND LOWER(COALESCE(o.payment_status,''))='paid'
      AND LOWER(COALESCE(o.book_option,''))='book'
  `);

  const donateQ = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM orders o
    WHERE ${offlineOrdersWhere("o")}
      AND LOWER(COALESCE(o.payment_status,''))='paid'
      AND LOWER(COALESCE(o.book_option,''))='donation'
  `);

  const revenueQ = await pool.query(`
    SELECT COALESCE(SUM(ab.total_amount),0)::int AS total
    FROM agent_bookings ab
    WHERE LOWER(COALESCE(ab.status,''))='paid'
  `);

  const todayRevenueQ = await pool.query(`
    SELECT COALESCE(SUM(ab.total_amount),0)::int AS total
    FROM agent_bookings ab
    WHERE LOWER(COALESCE(ab.status,''))='paid'
      AND DATE(ab.created_at)=CURRENT_DATE
  `);

  const salesDailyQ = await pool.query(`
    SELECT DATE(ab.created_at) AS d, COALESCE(SUM(ab.total_amount),0)::int AS revenue
    FROM agent_bookings ab
    WHERE LOWER(COALESCE(ab.status,''))='paid'
      AND ab.created_at >= (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY DATE(ab.created_at)
    ORDER BY d ASC
  `);

  const salesWeeklyQ = await pool.query(`
    SELECT DATE_TRUNC('week', ab.created_at)::date AS w, COALESCE(SUM(ab.total_amount),0)::int AS revenue
    FROM agent_bookings ab
    WHERE LOWER(COALESCE(ab.status,''))='paid'
      AND ab.created_at >= (CURRENT_DATE - INTERVAL '84 days')
    GROUP BY DATE_TRUNC('week', ab.created_at)
    ORDER BY w ASC
  `);

  const salesMonthlyQ = await pool.query(`
    SELECT DATE_TRUNC('month', ab.created_at)::date AS m, COALESCE(SUM(ab.total_amount),0)::int AS revenue
    FROM agent_bookings ab
    WHERE LOWER(COALESCE(ab.status,''))='paid'
      AND ab.created_at >= (CURRENT_DATE - INTERVAL '365 days')
    GROUP BY DATE_TRUNC('month', ab.created_at)
    ORDER BY m ASC
  `);

  const paidBookDetailsQ = await pool.query(`
    SELECT
      x.book_title,
      x.book_language,
      x.book_kind,
      COUNT(*)::int AS given_count
    FROM (
      SELECT
        COALESCE(NULLIF(TRIM(abl.book_title),''), c.default_book_title, 'Book') AS book_title,
        COALESCE(NULLIF(TRIM(abl.book_language),''), '-') AS book_language,
        'regular'::text AS book_kind
      FROM agent_bookings ab
      JOIN agent_booking_lines abl ON abl.agent_booking_id = ab.id
      JOIN contests c ON c.id = abl.contest_id
      WHERE LOWER(COALESCE(ab.status,''))='paid'
        AND LOWER(COALESCE(ab.delivery_mode,''))='handover'
        AND COALESCE(abl.line_status,'') <> 'cancelled'

      UNION ALL

      SELECT
        COALESCE(NULLIF(TRIM(abbi.book_title),''), 'Science of Self Realization') AS book_title,
        COALESCE(NULLIF(TRIM(abbi.book_language),''), '-') AS book_language,
        'bonus'::text AS book_kind
      FROM agent_bookings ab
      JOIN agent_booking_bonus_items abbi ON abbi.agent_booking_id = ab.id
      WHERE LOWER(COALESCE(ab.status,''))='paid'
        AND LOWER(COALESCE(ab.delivery_mode,''))='handover'
    ) x
    GROUP BY x.book_title, x.book_language, x.book_kind
    ORDER BY given_count DESC, x.book_kind ASC, x.book_title ASC, x.book_language ASC
  `);

  const contestStatsQ = await pool.query(`
    SELECT
      c.id,
      c.title,
      COUNT(o.id)::int AS registrations,
      COUNT(s.id)::int AS submitted
    FROM contests c
    LEFT JOIN orders o
      ON o.contest_id = c.id
     AND LOWER(COALESCE(o.payment_status,''))='paid'
     AND ${offlineOrdersWhere("o")}
    LEFT JOIN submissions s ON s.order_id = o.id
    GROUP BY c.id, c.title
    ORDER BY registrations DESC, c.title ASC
  `);

  res.render("admin/admin-offline-dashboard", {
    activeTab: "offline-dashboard",
    stats: {
      users: usersQ.rows[0].c,
      ordersAll: ordersAllQ.rows[0].c,
      paidOrders: paidOrdersQ.rows[0].c,
      pendingOrders: pendingFailedQ.rows[0].c,
      gift: giftQ.rows[0].c,
      donate: donateQ.rows[0].c,
      revenue: revenueQ.rows[0].total,
      todayRevenue: todayRevenueQ.rows[0].total,
    },
    series: {
      daily: salesDailyQ.rows,
      weekly: salesWeeklyQ.rows,
      monthly: salesMonthlyQ.rows,
    },
    paidBookDetails: paidBookDetailsQ.rows,
    contestStats: contestStatsQ.rows.map((r: any) => ({
      ...r,
      not_submitted: Math.max(0, Number(r.registrations) - Number(r.submitted)),
    })),
  });
});

router.get("/admin/shipments/download-pending", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {

   console.log("Called downl;oad pending:");
    const dateFrom = norm(req.query.date_from || "");
    const dateTo = norm(req.query.date_to || "");


    if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Please select both From and To dates, or leave both blank to include all matching rows.")
      );
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Date range is invalid. From date cannot be after To date.")
      );
    }

    const forcedReq = {
      query: {
        ...req.query,
        status: SHIPMENT_STATUS.PENDING,
        delivery_mode: "home_delivery",
      },
    };

    const rows = await fetchShipmentCsvRows(forcedReq);
    const filename = buildShipmentFileName("shipments_pending_download");
    res.setHeader("X-Downloaded-Count", String(rows.length));
    console.log("downl;oad pending reached final");
    return sendShipmentWorkbook(res, filename, rows, SHIPMENT_STATUS.PENDING, "", "Pending");
  } catch (e) {
    console.log("download pending Error:");
    console.error("download-pending error:", e);
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Failed to download pending home delivery shipments.")
    );
  }
});

function parseCsv(filePath: string): Record<string, any>[] {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
}

router.post(
  "/admin/shipments/upload-packed",
  authMiddleware,
  adminMiddleware,
  upload.single("packed_file"),
  async (req: any, res) => {
    const isAjax =
        String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

    try {
      const file = req.file;
      if (!file?.path) {
        return jsonBad(res, "No file uploaded");
      }

      const rows = parseCsv(file.path);

      let accepted = 0;
      const rejected: Record<string, any>[] = [];

      for (const r of rows) {
        try {
          const shipmentId = String(r["shipment_id"] || r["SHIPMENT_ID"] || "").trim();
          const trackingId = String(r["tracking_id"] || r["TRACKING_ID"] || "").trim();
          const packedFlag = String(r["packed_or_not"] || r["PACKED_OR_NOT"] || "").toLowerCase().trim();

          if (!shipmentId || !trackingId) {
            rejected.push({ ...r, reason: "Missing shipment_id or tracking_id" });
            continue;
          }

          const existing = await pool.query(
            `SELECT id, status, tracking_id, delivery_mode FROM shipments WHERE id = $1`,
            [shipmentId]
          );

          if (!existing.rows.length) {
            rejected.push({ ...r, reason: "Shipment not found" });
            continue;
          }

          const dbRow = existing.rows[0];

          if (String(dbRow.delivery_mode || "").toLowerCase() !== "home_delivery") {
            rejected.push({ ...r, reason: "Shipment is not home_delivery" });
            continue;
          }

          if (String(dbRow.status || "").toLowerCase() !== "under_packing") {
            rejected.push({ ...r, reason: "Not in under_packing status" });
            continue;
          }

          if (String(dbRow.tracking_id || "").trim() !== trackingId) {
            rejected.push({ ...r, reason: "Tracking ID mismatch" });
            continue;
          }

          if (!["yes", "no"].includes(packedFlag)) {
            rejected.push({ ...r, reason: "Invalid packed_or_not value" });
            continue;
          }

          if (packedFlag === "yes") {
            await pool.query(
              `UPDATE shipments SET status = 'packed', updated_at = NOW() WHERE id = $1`,
              [shipmentId]
            );
            accepted++;
          }
        } catch {
          rejected.push({ ...r, reason: "Internal error" });
        }
      }

      let rejectedFile = "";
      if (rejected.length) {
        const tmpName = `rejected_under_packing_${Date.now()}.xlsx`;
        const tmpPath = path.join(process.cwd(), "tmp", tmpName);
        const rejSheet = XLSX.utils.json_to_sheet(rejected);
        const rejWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
        XLSX.writeFile(rejWb, tmpPath);
        rejectedFile = tmpName;
      }

      fs.unlink(file.path, () => {});

      const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery" +
          "&okMsg=" + encodeURIComponent(`Under packing Excel update completed. Accepted: ${accepted}.`) +
          (rejected.length
            ? "&errorMsg=" + encodeURIComponent(`Rejected rows: ${rejected.length}.`)
            : "") +
          (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

        if (!isAjax) {
          return res.redirect(redirectUrl);
        }

        return jsonOk(res, {
          message: `Under packing Excel update completed.`,
          acceptedCount: accepted,
          rejectedCount: rejected.length,
          rejectedFile,
          redirectUrl
        });

    } catch (e) {
      console.error("upload-packed error:", e);
      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
        encodeURIComponent("Failed to process under packing shipment file.");

      if (!isAjax) {
        return res.redirect(redirectUrl);
      }

      return jsonBad(res, "Failed to process under packing shipment file.", {
        redirectUrl
      });

    }
  }
);


router.post(
  "/admin/shipments/upload-dispatched",
  authMiddleware,
  adminMiddleware,
  upload.single("dispatched_file"),
  async (req: any, res) => {
    let tmpRejectedPath = "";
    const isAjax =
  String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";
    try {
      if (!req.file?.path) {
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Please choose a dispatch file.")
        );
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("Uploaded dispatch file is empty.")
        );
      }

      const firstRow = rows[0] || {};

      const shipmentKey =
        "SHIPMENT_ID" in firstRow ? "SHIPMENT_ID" :
        "shipment_id" in firstRow ? "shipment_id" : "";

      /*const phoneKey =
        "PHONE" in firstRow ? "PHONE" :
        "phone" in firstRow ? "phone" : "";
      */


      const trackingKey =
        "TRACKING_ID" in firstRow ? "TRACKING_ID" :
        "tracking_id" in firstRow ? "tracking_id" : "";


      const dispatchedFlagKey =
      "DISPATCHED_OR_NOT" in firstRow ? "DISPATCHED_OR_NOT" :
      "dispatched_or_not" in firstRow ? "dispatched_or_not" : "";

    if (!shipmentKey || !trackingKey || !dispatchedFlagKey) {
      fs.unlink(req.file.path, () => {});
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Missing required columns. Expected SHIPMENT_ID, TRACKING_ID and DISPATCHED_OR_NOT.")
      );
    }

    const parsedRows: {
        rowNo: number;
        shipmentId: string;
        trackingId: string;
        dispatchedOrNot: string;
        raw: any;
      }[] = [];


      const rejectedRows: any[] = [];
      const seenTracking = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];

        const shipmentId = normalizeCell(row[shipmentKey]);
        const trackingId = normalizeCell(row[trackingKey]);
        const dispatchedOrNotRaw = normalizeCell(row[dispatchedFlagKey]).toLowerCase();
        const dispatchedOrNot =
        dispatchedOrNotRaw === "y" ? "yes" :
        dispatchedOrNotRaw === "n" ? "no" :
        dispatchedOrNotRaw;




        if (!shipmentId) {
          rejectedRows.push({ rowNo, shipmentId: "", trackingId, reason: "SHIPMENT_ID is empty" });
          continue;
        }

        if (!trackingId) {
          rejectedRows.push({ rowNo, shipmentId, trackingId, reason: "TRACKING_ID is empty" });
          continue;
        }

        if (!["yes", "no"].includes(dispatchedOrNot)) {
          rejectedRows.push({rowNo, shipmentId, trackingId, reason: "DISPATCHED_OR_NOT must be yes or no"});
          continue;
        }

        const trackingNorm = trackingId.toLowerCase();
        if (seenTracking.has(trackingNorm)) {
          rejectedRows.push({ rowNo, shipmentId,  trackingId, reason: "Duplicate TRACKING_ID inside upload file" });
          continue;
        }
        seenTracking.add(trackingNorm);

        parsedRows.push({ rowNo, shipmentId, trackingId, dispatchedOrNot, raw: row });
      }

      if (!parsedRows.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect(
          "/admin/shipments?errorMsg=" +
            encodeURIComponent("No valid rows found in dispatch file.")
        );
      }

      const shipmentIds = Array.from(new Set(parsedRows.map(r => r.shipmentId)));

      const dbQ = await pool.query(
            `
            SELECT
              sh.id AS shipment_id,
              sh.payment_id,
              sh.tracking_id,
              sh.status,
              sh.delivery_mode,
              sh.courier_mode,
              u.id AS user_id,
              u.name AS user_name,
              u.phone AS phone,
              
              (ARRAY_AGG(o.payment_session_id::text ORDER BY o.created_at ASC NULLS LAST))[1] AS payment_session_id
            FROM shipments sh
            JOIN shipment_items si ON si.shipment_id = sh.id
            JOIN orders o ON o.id = si.order_id
            JOIN users u ON u.id = o.user_id
            WHERE sh.id = ANY($1::uuid[])
            GROUP BY
              sh.id, sh.payment_id, sh.tracking_id, sh.status, sh.delivery_mode, sh.courier_mode,
              u.id, u.name
            `,
            [shipmentIds]
          );

      const dbMap = new Map<string, any>();
      for (const row of dbQ.rows) dbMap.set(String(row.shipment_id), row);

      const uploadedTrackingList = parsedRows.map(r => r.trackingId);
      const overlapQ = await pool.query(
        `
        SELECT id, tracking_id
        FROM shipments
        WHERE LOWER(COALESCE(tracking_id, '')) = ANY(
          SELECT LOWER(x) FROM unnest($1::text[]) AS x
        )
        `,
        [uploadedTrackingList]
      );

      const overlapMap = new Map<string, string>();
      for (const row of overlapQ.rows) {
        overlapMap.set(String(row.tracking_id || "").toLowerCase(), String(row.id));
      }

      const validRows: any[] = [];

      for (const row of parsedRows) {
        const dbRow = dbMap.get(row.shipmentId);

        if (!dbRow) {
          rejectedRows.push({ ...row, reason: "Shipment not found" });
          continue;
        }

        if (String(dbRow.delivery_mode || "").toLowerCase() !== "home_delivery") {
          rejectedRows.push({ ...row, reason: "Shipment is not home_delivery" });
          continue;
        }

        if (String(dbRow.status || "").toLowerCase() !== "packed") {
          rejectedRows.push({ ...row, reason: "Shipment status is not packed" });
          continue;
        }

       if (normalizeCompare(dbRow.tracking_id) !== normalizeCompare(row.trackingId)) {
        rejectedRows.push({ ...row, reason: "Tracking ID mismatch" });
        continue;
      }

        const overlapShipmentId = overlapMap.get(String(row.trackingId || "").toLowerCase());
        if (overlapShipmentId && overlapShipmentId !== row.shipmentId) {
          rejectedRows.push({ ...row, reason: "TRACKING_ID already used by another shipment" });
          continue;
        }

        if (row.dispatchedOrNot === "yes") {
          validRows.push({
            shipmentId: row.shipmentId,
            paymentId: dbRow.payment_id,
            paymentSessionId: dbRow.payment_session_id || null,
            userId: dbRow.user_id,
            userName: dbRow.user_name,
            phone:dbRow.phone,
            trackingId: row.trackingId,
            courierMode: normalizeCell(dbRow.courier_mode) || "india_post",
          });
        }

      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const row of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = $2,
              status = 'dispatched',
              updated_at = NOW()
            WHERE id = $3
              AND LOWER(COALESCE(status, '')) = 'packed'
              AND LOWER(COALESCE(delivery_mode, '')) = 'home_delivery'
            `,
            [row.trackingId, row.courierMode, row.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      /*
      for (const row of validRows) {
        try {
          //console.log("Sending disptached confirmation to:", row.phone);
          //console.log("Tracking id:", row.trackingId);
          await sendShipmentDispatchMessageOnce({
            paymentId: String(row.paymentId || ""),
            paymentSessionId: row.paymentSessionId,
            userId: String(row.userId || ""),
            phone: String(row.phone || ""),
            userName: String(row.userName || "Participant"),
            trackingId: String(row.trackingId || ""),
          });
        } catch (e) {
          console.error("shipment dispatch whatsapp send error:", e);
        }
      }
      */

      let rejectedFile = "";

        if (rejectedRows.length) {
          const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
          const rejWb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");

          const tmpName = `rejected_packed_to_dispatched_${Date.now()}.xlsx`;
          const tmpPath = path.join(process.cwd(), "tmp", tmpName);
          XLSX.writeFile(rejWb, tmpPath);
          rejectedFile = tmpName;
        }

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery" +
        "&okMsg=" + encodeURIComponent(`Dispatch update completed. Accepted: ${validRows.length}.`) +
        (rejectedRows.length
          ? "&errorMsg=" + encodeURIComponent(`Rejected rows: ${rejectedRows.length}.`)
          : "") +
        (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

      if (!isAjax) {
        return res.redirect(redirectUrl);
      }

      return jsonOk(res, {
        message: `Dispatch update completed.`,
        acceptedCount: validRows.length,
        rejectedCount: rejectedRows.length,
        rejectedFile,
        redirectUrl
      });
    } catch (e) {
         console.error("upload-dispatched error:", e);

         const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Failed to import dispatched shipment file.");

        if (req.file?.path) fs.unlink(req.file.path, () => {});

        if (!isAjax) {
          return res.redirect(redirectUrl);
        }

        return jsonBad(res, "Failed to import dispatched shipment file.", {
          redirectUrl
        });

    }
  }
);


router.post(
  "/admin/shipments/upload-returned",
  authMiddleware,
  adminMiddleware,
  upload.single("returned_file"),
  async (req: any, res) => {
    const isAjax =
      String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

    try {
      if (!req.file?.path) {
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Please choose a returned shipment file.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Please choose a returned shipment file.", { redirectUrl });
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Uploaded returned file is empty.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Uploaded returned file is empty.", { redirectUrl });
      }

      const firstRow = rows[0] || {};
      const trackingKey =
        "TRACKING_ID" in firstRow ? "TRACKING_ID" :
        "tracking_id" in firstRow ? "tracking_id" : "";

      if (!trackingKey) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Missing required column. Expected TRACKING_ID.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Missing required column. Expected TRACKING_ID.", { redirectUrl });
      }

      const parsedRows: { rowNo: number; trackingId: string; raw: any }[] = [];
      const rejectedRows: any[] = [];
      const uploadDuplicateTracking = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];
        const trackingId = normalizeCell(row[trackingKey]);

        if (!trackingId) {
          rejectedRows.push({ ...row, ERROR_REASON: "Tracking id is empty", ERROR_ROW_NO: rowNo });
          continue;
        }

        const normTracking = normalizeCompare(trackingId);
        if (uploadDuplicateTracking.has(normTracking)) {
          fs.unlink(req.file.path, () => {});
          const redirectUrl =
            "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
            encodeURIComponent("Duplicate TRACKING_ID found in uploaded file. Entire upload rejected.");
          if (!isAjax) return res.redirect(redirectUrl);
          return jsonBad(res, "Duplicate TRACKING_ID found in uploaded file. Entire upload rejected.", { redirectUrl });
        }

        uploadDuplicateTracking.add(normTracking);
        parsedRows.push({ rowNo, trackingId, raw: row });
      }

      const trackingIds = Array.from(new Set(parsedRows.map(r => r.trackingId)));

      const dbQ = await pool.query(
        `
        SELECT id, status, delivery_mode, tracking_id
        FROM shipments
        WHERE LOWER(COALESCE(tracking_id, '')) = ANY(
          SELECT LOWER(x) FROM unnest($1::text[]) AS x
        )
        `,
        [trackingIds]
      );

      const dbMap = new Map<string, any>();
      for (const r of dbQ.rows) dbMap.set(normalizeCompare(r.tracking_id), r);

      const validRows: { shipmentId: string }[] = [];

      for (const row of parsedRows) {
        const dbRow = dbMap.get(normalizeCompare(row.trackingId));

        if (!dbRow) {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Tracking id not found", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.delivery_mode || "").toLowerCase() !== "home_delivery") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment is not home_delivery", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.status || "").toLowerCase() !== "dispatched") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment status is not dispatched", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        validRows.push({ shipmentId: String(dbRow.id) });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const row of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              status = 'returned',
              updated_at = NOW()
            WHERE id = $1
              AND LOWER(COALESCE(status, '')) = 'dispatched'
            `,
            [row.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      let rejectedFile = "";
      if (rejectedRows.length) {
        const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
        const rejWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
        const tmpName = `rejected_returned_${Date.now()}.xlsx`;
        const tmpPath = path.join(process.cwd(), "tmp", tmpName);
        XLSX.writeFile(rejWb, tmpPath);
        rejectedFile = tmpName;
      }

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery" +
        "&okMsg=" + encodeURIComponent(`Returned update completed. Accepted: ${validRows.length}.`) +
        (rejectedRows.length
          ? "&errorMsg=" + encodeURIComponent(`Rejected rows: ${rejectedRows.length}.`)
          : "") +
        (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

      if (!isAjax) return res.redirect(redirectUrl);

      return jsonOk(res, {
        message: "Returned update completed.",
        acceptedCount: validRows.length,
        rejectedCount: rejectedRows.length,
        rejectedFile,
        redirectUrl
      });
    } catch (e) {
      console.error("upload-returned error:", e);
      if (req.file?.path) fs.unlink(req.file.path, () => {});

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
        encodeURIComponent("Failed to import returned shipment file.");

      if (!isAjax) return res.redirect(redirectUrl);
      return jsonBad(res, "Failed to import returned shipment file.", { redirectUrl });
    }
  }
);

router.post(
  "/admin/shipments/upload-returned-restart",
  authMiddleware,
  adminMiddleware,
  upload.single("returned_restart_file"),
  async (req: any, res) => {
    const isAjax =
      String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

    try {
      if (!req.file?.path) {
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Please choose a returned restart file.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Please choose a returned restart file.", { redirectUrl });
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Uploaded returned restart file is empty.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Uploaded returned restart file is empty.", { redirectUrl });
      }

      const firstRow = rows[0] || {};

      const shipmentKey =
        "SHIPMENT_ID" in firstRow ? "SHIPMENT_ID" :
        "shipment_id" in firstRow ? "shipment_id" : "";

      const trackingKey =
        "TRACKING_ID" in firstRow ? "TRACKING_ID" :
        "tracking_id" in firstRow ? "tracking_id" : "";

      const startAgainKey =
        "START_AGAIN" in firstRow ? "START_AGAIN" :
        "start_again" in firstRow ? "start_again" : "";

      if (!shipmentKey || !trackingKey || !startAgainKey) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Missing required columns. Expected SHIPMENT_ID, TRACKING_ID and START_AGAIN.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Missing required columns. Expected SHIPMENT_ID, TRACKING_ID and START_AGAIN.", { redirectUrl });
      }

      const parsedRows: {
        rowNo: number;
        shipmentId: string;
        trackingId: string;
        startAgain: string;
        raw: any;
      }[] = [];

      const rejectedRows: any[] = [];
      const seenShipmentIds = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];

        const shipmentId = normalizeCell(row[shipmentKey]);
        const trackingId = normalizeCell(row[trackingKey]);
        const startAgainRaw = normalizeCell(row[startAgainKey]).toLowerCase();
        const startAgain =
          startAgainRaw === "y" ? "yes" :
          startAgainRaw === "n" ? "no" :
          startAgainRaw;

        if (!shipmentId) {
          rejectedRows.push({ ...row, ERROR_REASON: "SHIPMENT_ID is empty", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (!trackingId) {
          rejectedRows.push({ ...row, ERROR_REASON: "TRACKING_ID is empty", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (!["yes", "no"].includes(startAgain)) {
          rejectedRows.push({ ...row, ERROR_REASON: "START_AGAIN must be yes or no", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (seenShipmentIds.has(normalizeCompare(shipmentId))) {
          rejectedRows.push({ ...row, ERROR_REASON: "Duplicate SHIPMENT_ID inside upload file", ERROR_ROW_NO: rowNo });
          continue;
        }
        seenShipmentIds.add(normalizeCompare(shipmentId));

        parsedRows.push({ rowNo, shipmentId, trackingId, startAgain, raw: row });
      }

      const shipmentIds = Array.from(new Set(parsedRows.map(r => r.shipmentId)));
      const dbQ = await pool.query(
        `
        SELECT id, status, delivery_mode, tracking_id
        FROM shipments
        WHERE id = ANY($1::uuid[])
        `,
        [shipmentIds]
      );

      const dbMap = new Map<string, any>();
      for (const row of dbQ.rows) dbMap.set(String(row.id), row);

      const validRows: { shipmentId: string }[] = [];

      for (const row of parsedRows) {
        const dbRow = dbMap.get(row.shipmentId);

        if (!dbRow) {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment not found", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.delivery_mode || "").toLowerCase() !== "home_delivery") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment is not home_delivery", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.status || "").toLowerCase() !== "returned") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment status is not returned", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (normalizeCompare(dbRow.tracking_id) !== normalizeCompare(row.trackingId)) {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Tracking ID mismatch", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (row.startAgain === "yes") {
          validRows.push({ shipmentId: row.shipmentId });
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const row of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              status = 'pending',
              updated_at = NOW()
            WHERE id = $1
              AND LOWER(COALESCE(status, '')) = 'returned'
            `,
            [row.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      let rejectedFile = "";
      if (rejectedRows.length) {
        const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
        const rejWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
        const tmpName = `rejected_returned_restart_${Date.now()}.xlsx`;
        const tmpPath = path.join(process.cwd(), "tmp", tmpName);
        XLSX.writeFile(rejWb, tmpPath);
        rejectedFile = tmpName;
      }

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery" +
        "&okMsg=" + encodeURIComponent(`Returned restart update completed. Accepted: ${validRows.length}.`) +
        (rejectedRows.length
          ? "&errorMsg=" + encodeURIComponent(`Rejected rows: ${rejectedRows.length}.`)
          : "") +
        (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

      if (!isAjax) return res.redirect(redirectUrl);

      return jsonOk(res, {
        message: "Returned restart update completed.",
        acceptedCount: validRows.length,
        rejectedCount: rejectedRows.length,
        rejectedFile,
        redirectUrl
      });
    } catch (e) {
      console.error("upload-returned-restart error:", e);
      if (req.file?.path) fs.unlink(req.file.path, () => {});

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
        encodeURIComponent("Failed to import returned restart shipment file.");

      if (!isAjax) return res.redirect(redirectUrl);
      return jsonBad(res, "Failed to import returned restart shipment file.", { redirectUrl });
    }
  }
);

router.post(
  "/admin/shipments/upload-delivered",
  authMiddleware,
  adminMiddleware,
  upload.single("delivered_file"),
  async (req: any, res) => {
    const isAjax =
      String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

    try {
      if (!req.file?.path) {
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Please choose a delivered file.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Please choose a delivered file.", { redirectUrl });
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Uploaded delivered file is empty.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Uploaded delivered file is empty.", { redirectUrl });
      }

      const firstRow = rows[0] || {};

      const shipmentKey =
        "SHIPMENT_ID" in firstRow ? "SHIPMENT_ID" :
        "shipment_id" in firstRow ? "shipment_id" : "";

      const trackingKey =
        "TRACKING_ID" in firstRow ? "TRACKING_ID" :
        "tracking_id" in firstRow ? "tracking_id" : "";

      const deliveredFlagKey =
        "DELIVERED_OR_NOT" in firstRow ? "DELIVERED_OR_NOT" :
        "delivered_or_not" in firstRow ? "delivered_or_not" : "";

      if (!shipmentKey || !trackingKey || !deliveredFlagKey) {
        fs.unlink(req.file.path, () => {});
        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
          encodeURIComponent("Missing required columns. Expected SHIPMENT_ID, TRACKING_ID and DELIVERED_OR_NOT.");
        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "Missing required columns. Expected SHIPMENT_ID, TRACKING_ID and DELIVERED_OR_NOT.", { redirectUrl });
      }

      const parsedRows: {
        rowNo: number;
        shipmentId: string;
        trackingId: string;
        deliveredOrNot: string;
        raw: any;
      }[] = [];

      const rejectedRows: any[] = [];
      const seenShipmentIds = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];

        const shipmentId = normalizeCell(row[shipmentKey]);
        const trackingId = normalizeCell(row[trackingKey]);
        const deliveredOrNotRaw = normalizeCell(row[deliveredFlagKey]).toLowerCase();
        const deliveredOrNot =
          deliveredOrNotRaw === "y" ? "yes" :
          deliveredOrNotRaw === "n" ? "no" :
          deliveredOrNotRaw;

        if (!shipmentId) {
          rejectedRows.push({ ...row, ERROR_REASON: "SHIPMENT_ID is empty", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (!trackingId) {
          rejectedRows.push({ ...row, ERROR_REASON: "TRACKING_ID is empty", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (!["yes", "no"].includes(deliveredOrNot)) {
          rejectedRows.push({ ...row, ERROR_REASON: "DELIVERED_OR_NOT must be yes or no", ERROR_ROW_NO: rowNo });
          continue;
        }

        if (seenShipmentIds.has(normalizeCompare(shipmentId))) {
          rejectedRows.push({ ...row, ERROR_REASON: "Duplicate SHIPMENT_ID inside upload file", ERROR_ROW_NO: rowNo });
          continue;
        }
        seenShipmentIds.add(normalizeCompare(shipmentId));

        parsedRows.push({ rowNo, shipmentId, trackingId, deliveredOrNot, raw: row });
      }

      if (!parsedRows.length) {
        fs.unlink(req.file.path, () => {});
        let rejectedFile = "";
        if (rejectedRows.length) {
          const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
          const rejWb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
          const tmpName = `rejected_delivered_${Date.now()}.xlsx`;
          const tmpPath = path.join(process.cwd(), "tmp", tmpName);
          XLSX.writeFile(rejWb, tmpPath);
          rejectedFile = tmpName;
        }

        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery" +
          "&errorMsg=" + encodeURIComponent("No valid rows found in delivered file.") +
          (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

        if (!isAjax) return res.redirect(redirectUrl);
        return jsonBad(res, "No valid rows found in delivered file.", {
          rejectedCount: rejectedRows.length,
          rejectedFile,
          redirectUrl
        });
      }

      const shipmentIds = Array.from(new Set(parsedRows.map(r => r.shipmentId)));

      const dbQ = await pool.query(
        `
        SELECT id, status, delivery_mode, tracking_id, courier_mode
        FROM shipments
        WHERE id = ANY($1::uuid[])
        `,
        [shipmentIds]
      );

      const dbMap = new Map<string, any>();
      for (const row of dbQ.rows) dbMap.set(String(row.id), row);

      const validRows: { shipmentId: string; trackingId: string; courierMode: string }[] = [];

      for (const row of parsedRows) {
        const dbRow = dbMap.get(row.shipmentId);

        if (!dbRow) {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment not found", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.delivery_mode || "").toLowerCase() !== "home_delivery") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment is not home_delivery", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (String(dbRow.status || "").toLowerCase() !== "dispatched") {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Shipment status is not dispatched", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (normalizeCompare(dbRow.tracking_id) !== normalizeCompare(row.trackingId)) {
          rejectedRows.push({ ...row.raw, ERROR_REASON: "Tracking ID mismatch", ERROR_ROW_NO: row.rowNo });
          continue;
        }

        if (row.deliveredOrNot === "yes") {
          validRows.push({
            shipmentId: row.shipmentId,
            trackingId: row.trackingId,
            courierMode: normalizeCell(dbRow.courier_mode) || "india_post",
          });
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const row of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = $2,
              status = 'delivered',
              updated_at = NOW()
            WHERE id = $3
              AND LOWER(COALESCE(status, '')) = 'dispatched'
              AND LOWER(COALESCE(delivery_mode, '')) = 'home_delivery'
            `,
            [row.trackingId, row.courierMode, row.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      let rejectedFile = "";
      if (rejectedRows.length) {
        const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
        const rejWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
        const tmpName = `rejected_delivered_${Date.now()}.xlsx`;
        const tmpPath = path.join(process.cwd(), "tmp", tmpName);
        XLSX.writeFile(rejWb, tmpPath);
        rejectedFile = tmpName;
      }

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery" +
        "&okMsg=" + encodeURIComponent(`Delivered update completed. Accepted: ${validRows.length}.`) +
        (rejectedRows.length
          ? "&errorMsg=" + encodeURIComponent(`Rejected rows: ${rejectedRows.length}.`)
          : "") +
        (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

      if (!isAjax) return res.redirect(redirectUrl);

      return jsonOk(res, {
        message: "Delivered update completed.",
        acceptedCount: validRows.length,
        rejectedCount: rejectedRows.length,
        rejectedFile,
        redirectUrl
      });
    } catch (e) {
      console.error("upload-delivered error:", e);
      if (req.file?.path) fs.unlink(req.file.path, () => {});

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
        encodeURIComponent("Failed to import delivered shipment file.");

      if (!isAjax) return res.redirect(redirectUrl);
      return jsonBad(res, "Failed to import delivered shipment file.", { redirectUrl });
    }
  }
);

router.get("/admin/shipments/download-packed", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const dateFrom = norm(req.query.date_from || "");
    const dateTo = norm(req.query.date_to || "");

    if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
  return res.redirect(
    "/admin/shipments?errorMsg=" +
      encodeURIComponent("Please select both From and To dates, or leave both blank to include all matching rows.")
  );
}

if (dateFrom && dateTo && dateFrom > dateTo) {
  return res.redirect(
    "/admin/shipments?errorMsg=" +
      encodeURIComponent("Date range is invalid. From date cannot be after To date.")
  );
}

    const forcedReq = {
      query: {
        ...req.query,
        status: "packed",
        delivery_mode: "home_delivery",
      },
    };

    const rows = await fetchShipmentCsvRows(forcedReq);
    const filename = buildShipmentFileName("shipments_packed_home_delivery");
    return sendShipmentWorkbook(res, filename, rows, undefined, "DISPATCHED_OR_NOT", "Packed");
  } catch (e) {
    console.error("download-packed error:", e);
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Failed to download packed home delivery shipments.")
    );
  }
});


router.get("/admin/shipments/download-status", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const status = norm(req.query.status || "").toLowerCase();
    const allowed = new Set(["under_packing", "dispatched","delivered" ,"returned"]);

    if (!allowed.has(status)) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Unsupported status download request.")
      );
    }

    const forcedReq = {
      query: {
        ...req.query,
        q: norm(req.query.q || ""),
        status,
        delivery_mode: "home_delivery",
      },
    };

    const rows = await fetchShipmentCsvRows(forcedReq);

    const extraFlag =
      status === "under_packing" ? "PACKED_OR_NOT" :
      status === "dispatched" ? "DELIVERED_OR_NOT" :
      status === "delivered"     ? "" :

      status === "returned" ? "START_AGAIN" :
      "";

    const filename = buildShipmentFileName(`shipments_${status}_home_delivery`);
    return sendShipmentWorkbook(res, filename, rows, undefined, extraFlag as any, String(status || "shipments"));
  } catch (e) {
    console.error("download-status error:", e);
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Failed to download shipment file.")
    );
  }
});

router.post("/admin/shipments/bulk-advance-status", authMiddleware, adminMiddleware, async (req: any, res) => {
  try {
    const fromStatus = norm(req.body.from_status).toLowerCase();
    const toStatus = norm(req.body.to_status).toLowerCase();
    const deliveryMode = norm(req.body.delivery_mode || "home_delivery").toLowerCase();

    const allowedPairs = new Set([
      "pending=>under_packing",
      "under_packing=>packed",
      "packed=>dispatched",
      "dispatched=>delivered",
      "returned=>pending",
    ]);

    const pair = `${fromStatus}=>${toStatus}`;
    if (!allowedPairs.has(pair)) {
      return res.redirect(
        "/admin/shipments?errorMsg=" +
          encodeURIComponent("Unsupported bulk update transition.")
      );
    }

    const fakeReq = {
      query: {
        q: norm(req.body.q || ""),
        status: fromStatus,
        date_from: norm(req.body.date_from || ""),
        date_to: norm(req.body.date_to || ""),
        delivery_mode: deliveryMode,
      }
    };

    const { whereSql, params } = buildShipmentsFilter(fakeReq);

    const updateCourierMode =
      toStatus === "dispatched" ? "india_post" :
      toStatus === "delivered" ? "admin_bulk_delivered" :
      null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const countQ = await client.query(
        `
        SELECT COUNT(DISTINCT sh.id)::int AS c
        FROM shipments sh
        JOIN shipment_items si ON si.shipment_id = sh.id
        JOIN orders o ON o.id = si.order_id
        JOIN users u ON u.id = o.user_id
        JOIN contests c ON c.id = o.contest_id
        ${whereSql}
        `,
        params
      );

      const affected = Number(countQ.rows[0]?.c || 0);
      const updateWhereSql = whereSql
          .replace(/sh\./g, "sh2.")
          .replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 2}`);

        await client.query(
          `
          UPDATE shipments sh
          SET
            status = $1,
            courier_mode = CASE
              WHEN $2::text IS NULL OR $2::text = '' THEN sh.courier_mode
              ELSE COALESCE(NULLIF(sh.courier_mode,''), $2)
            END,
            updated_at = NOW()
          WHERE sh.id IN (
            SELECT DISTINCT sh2.id
            FROM shipments sh2
            JOIN shipment_items si ON si.shipment_id = sh2.id
            JOIN orders o ON o.id = si.order_id
            JOIN users u ON u.id = o.user_id
            JOIN contests c ON c.id = o.contest_id
            ${updateWhereSql}
          )
          `,
          [toStatus, updateCourierMode, ...params]
        );


      await client.query("COMMIT");

      return res.redirect(
        "/admin/shipments?okMsg=" +
          encodeURIComponent(`Bulk update completed. ${affected} shipment(s) moved from ${fromStatus} to ${toStatus}.`)
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("bulk-advance-status error:", e);
    return res.redirect(
      "/admin/shipments?errorMsg=" +
        encodeURIComponent("Failed to run bulk shipment update.")
    );
  }
});


router.post("/admin/shipments/upload-under-packing", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.json({ ok: false, error: "No file uploaded" });

  const rows = parseCsv(file.buffer.toString());

  let accepted = 0;
  let rejected = [];

  for (const r of rows) {
    try {
      const shipmentId = String(r.shipment_id || "").trim();
      const trackingId = String(r.tracking_id || "").trim();
      const packedFlag = String(r.packed_or_not || "").toLowerCase().trim();

      if (!shipmentId || !trackingId) {
        rejected.push({ ...r, reason: "Missing shipment_id or tracking_id" });
        continue;
      }

      const existing = await pool.query(
        `SELECT id, status, tracking_id FROM shipments WHERE id = $1`,
        [shipmentId]
      );

      if (existing.rowCount === 0) {
        rejected.push({ ...r, reason: "Shipment not found" });
        continue;
      }

      const dbRow = existing.rows[0];

      if (dbRow.status !== "under_packing") {
        rejected.push({ ...r, reason: "Not in under_packing status" });
        continue;
      }

      if (dbRow.tracking_id !== trackingId) {
        rejected.push({ ...r, reason: "Tracking ID mismatch" });
        continue;
      }

      if (!["yes", "no"].includes(packedFlag)) {
        rejected.push({ ...r, reason: "Invalid packed_or_not value" });
        continue;
      }

      if (packedFlag === "yes") {
        await pool.query(
          `UPDATE shipments SET status = 'packed' WHERE id = $1`,
          [shipmentId]
        );
        accepted++;
      }

      // if "no" → do nothing

    } catch (e) {
      rejected.push({ ...r, reason: "Internal error" });
    }
  }

  return res.json({
    ok: true,
    accepted,
    rejectedCount: rejected.length,
    rejected
  });
});

router.post(
  "/admin/shipments/bulk-upload-status",
  authMiddleware,
  adminMiddleware,
  upload.single("status_file"),
  async (req: any, res) => {
    try {
      const isAjax =
        String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

      if (!req.file?.path) {
        if (!isAjax) {
          return res.redirect(
            "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
              encodeURIComponent("Please choose an Excel file (.xlsx or .xls).")
          );
        }
        return jsonBad(res, "Please choose an Excel file (.xlsx or .xls).");
      }

      const fromStatus = norm(req.body.from_status).toLowerCase();
      const toStatus = norm(req.body.to_status).toLowerCase();
      const deliveryMode = norm(req.body.delivery_mode || "home_delivery").toLowerCase();

      if (!(fromStatus === "pending" && toStatus === "under_packing")) {
        fs.unlink(req.file.path, () => {});
        if (!isAjax) {
          return res.redirect(
            "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
              encodeURIComponent("Unsupported Excel transition.")
          );
        }
        return jsonBad(res, "Unsupported Excel transition.");
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        if (!isAjax) {
          return res.redirect(
            "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
              encodeURIComponent("Uploaded file is empty.")
          );
        }
        return jsonBad(res, "Uploaded file is empty.");
      }

      const firstRow = rows[0] || {};

      const shipmentKey =
        "SHIPMENT_ID" in firstRow
          ? "SHIPMENT_ID"
          : "shipment_id" in firstRow
          ? "shipment_id"
          : "";

      const trackingKey =
        "TRACKING_ID" in firstRow
          ? "TRACKING_ID"
          : "tracking_id" in firstRow
          ? "tracking_id"
          : "";

      if (!shipmentKey || !trackingKey) {
        fs.unlink(req.file.path, () => {});
        const msg = "Missing required columns. Expected SHIPMENT_ID and TRACKING_ID.";
        if (!isAjax) {
          return res.redirect(
            "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
              encodeURIComponent(msg)
          );
        }
        return jsonBad(res, msg);
      }

      const parsedRows: {
        rowNo: number;
        shipmentId: string;
        trackingId: string;
        raw: any;
      }[] = [];

      const rejectedRows: any[] = [];

      for (let i = 0; i < rows.length; i++) {
        const rowNo = i + 2;
        const row = rows[i];

        const shipmentId = normalizeCell(row[shipmentKey]);
        const trackingId = normalizeCell(row[trackingKey]);

        if (!shipmentId) {
          rejectedRows.push({
            ...row,
            ERROR_REASON: "SHIPMENT_ID is empty",
            ERROR_ROW_NO: rowNo,
          });
          continue;
        }

        if (!trackingId) {
          rejectedRows.push({
            ...row,
            ERROR_REASON: "TRACKING_ID is empty",
            ERROR_ROW_NO: rowNo,
          });
          continue;
        }

        parsedRows.push({
          rowNo,
          shipmentId,
          trackingId,
          raw: row,
        });
      }

      if (!parsedRows.length) {
        fs.unlink(req.file.path, () => {});

        let rejectedFile = "";
        if (rejectedRows.length) {
          const tmpName = `rejected_pending_${Date.now()}.xlsx`;
          const tmpPath = path.join(process.cwd(), "tmp", tmpName);
          const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
          const rejWb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
          XLSX.writeFile(rejWb, tmpPath);
          rejectedFile = tmpName;
        }

        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery" +
          "&errorMsg=" + encodeURIComponent("No valid rows found in uploaded file.") +
          (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

        if (!isAjax) {
          return res.redirect(redirectUrl);
        }

        return jsonBad(res, "No valid rows found in uploaded file.", {
          rejectedCount: rejectedRows.length,
          rejectedFile,
          redirectUrl,
        });
      }

      // Strict duplicate tracking check INSIDE uploaded file
      const trackingCount = new Map<string, number>();
      for (const r of parsedRows) {
        const key = normalizeCompare(r.trackingId);
        trackingCount.set(key, (trackingCount.get(key) || 0) + 1);
      }

      const duplicateTrackingSet = new Set<string>();
      for (const [key, count] of trackingCount.entries()) {
        if (count > 1) duplicateTrackingSet.add(key);
      }

      // If any duplicate exists in uploaded file, reject ENTIRE upload
      if (duplicateTrackingSet.size > 0) {
        const duplicateRows = parsedRows.map((r) => ({
          ...r.raw,
          ERROR_REASON: duplicateTrackingSet.has(normalizeCompare(r.trackingId))
            ? "Duplicate TRACKING_ID found in uploaded file"
            : "Upload cancelled because duplicate TRACKING_ID exists elsewhere in this file",
          ERROR_ROW_NO: r.rowNo,
        }));

        const allRejected = [...rejectedRows, ...duplicateRows];

        let rejectedFile = "";
        if (allRejected.length) {
          const tmpName = `rejected_pending_${Date.now()}.xlsx`;
          const tmpPath = path.join(process.cwd(), "tmp", tmpName);
          const rejSheet = XLSX.utils.json_to_sheet(allRejected);
          const rejWb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
          XLSX.writeFile(rejWb, tmpPath);
          rejectedFile = tmpName;
        }

        fs.unlink(req.file.path, () => {});

        const redirectUrl =
          "/admin/shipments?delivery_mode=home_delivery" +
          "&okMsg=" + encodeURIComponent("0 shipment(s) moved from pending to under_packing.") +
          "&errorMsg=" +
          encodeURIComponent("Upload cancelled because duplicate TRACKING_ID was found in the file.") +
          (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

        if (!isAjax) {
          return res.redirect(redirectUrl);
        }

        return jsonOk(res, {
          message:
            "Pending Excel update cancelled. Duplicate TRACKING_ID found in uploaded file, so no rows were updated.",
          acceptedCount: 0,
          rejectedCount: allRejected.length,
          rejectedFile,
          redirectUrl,
        });
      }

      const shipmentIds = Array.from(new Set(parsedRows.map((r) => r.shipmentId)));

      const dbQ = await pool.query(
        `
        SELECT
          id,
          status,
          delivery_mode,
          tracking_id
        FROM shipments
        WHERE id = ANY($1::uuid[])
        `,
        [shipmentIds]
      );

      const dbMap = new Map<string, any>();
      for (const row of dbQ.rows) {
        dbMap.set(String(row.id), row);
      }

      // Check overlap with existing tracking ids already used in DB
      const uploadedTrackingIds = Array.from(
        new Set(parsedRows.map((r) => normalizeCompare(r.trackingId)))
      );

      const overlapQ = await pool.query(
        `
        SELECT id, tracking_id
        FROM shipments
        WHERE LOWER(COALESCE(tracking_id, '')) = ANY($1::text[])
        `,
        [uploadedTrackingIds]
      );

      const trackingToShipmentIds = new Map<string, string[]>();
      for (const row of overlapQ.rows) {
        const key = normalizeCompare(row.tracking_id);
        const arr = trackingToShipmentIds.get(key) || [];
        arr.push(String(row.id));
        trackingToShipmentIds.set(key, arr);
      }

      const validRows: { shipmentId: string; trackingId: string }[] = [];

      for (const r of parsedRows) {
        const dbRow = dbMap.get(r.shipmentId);

        if (!dbRow) {
          rejectedRows.push({
            ...r.raw,
            ERROR_REASON: "Shipment id not found",
            ERROR_ROW_NO: r.rowNo,
          });
          continue;
        }

        if (normalizeCompare(dbRow.delivery_mode) !== deliveryMode) {
          rejectedRows.push({
            ...r.raw,
            ERROR_REASON: `Shipment is not ${deliveryMode}`,
            ERROR_ROW_NO: r.rowNo,
          });
          continue;
        }

        if (normalizeCompare(dbRow.status) !== fromStatus) {
          rejectedRows.push({
            ...r.raw,
            ERROR_REASON: `Shipment is not in ${fromStatus} status`,
            ERROR_ROW_NO: r.rowNo,
          });
          continue;
        }

        const usedBy = trackingToShipmentIds.get(normalizeCompare(r.trackingId)) || [];
        const usedByAnotherShipment = usedBy.some((id) => id !== r.shipmentId);

        if (usedByAnotherShipment) {
          rejectedRows.push({
            ...r.raw,
            ERROR_REASON: "TRACKING_ID already used by another shipment",
            ERROR_ROW_NO: r.rowNo,
          });
          continue;
        }

        validRows.push({
          shipmentId: r.shipmentId,
          trackingId: r.trackingId,
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const r of validRows) {
          await client.query(
            `
            UPDATE shipments
            SET
              tracking_id = $1,
              courier_mode = 'india_post',
              status = 'under_packing',
              updated_at = NOW()
            WHERE id = $2
              AND LOWER(COALESCE(status, '')) = 'pending'
              AND LOWER(COALESCE(delivery_mode, '')) = 'home_delivery'
            `,
            [r.trackingId, r.shipmentId]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      fs.unlink(req.file.path, () => {});

      let rejectedFile = "";
      if (rejectedRows.length) {
        const tmpName = `rejected_pending_${Date.now()}.xlsx`;
        const tmpPath = path.join(process.cwd(), "tmp", tmpName);
        const rejSheet = XLSX.utils.json_to_sheet(rejectedRows);
        const rejWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(rejWb, rejSheet, "Rejected");
        XLSX.writeFile(rejWb, tmpPath);
        rejectedFile = tmpName;
      }

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery" +
        "&okMsg=" +
        encodeURIComponent(`${validRows.length} shipment(s) moved from pending to under_packing.`) +
        (rejectedRows.length
          ? "&errorMsg=" + encodeURIComponent(`${rejectedRows.length} row(s) were rejected.`)
          : "") +
        (rejectedFile ? "&rejectedFile=" + encodeURIComponent(rejectedFile) : "");

      if (!isAjax) {
        return res.redirect(redirectUrl);
      }

      return jsonOk(res, {
        message: "Pending Excel update completed.",
        acceptedCount: validRows.length,
        rejectedCount: rejectedRows.length,
        rejectedFile,
        redirectUrl,
      });
    } catch (e) {
      console.error("bulk-upload-status error:", e);
      if (req.file?.path) fs.unlink(req.file.path, () => {});

      const redirectUrl =
        "/admin/shipments?delivery_mode=home_delivery&errorMsg=" +
        encodeURIComponent("Failed to process uploaded shipment file.");

      const isAjax =
        String(req.get("X-Requested-With") || "").toLowerCase() === "xmlhttprequest";

      if (!isAjax) {
        return res.redirect(redirectUrl);
      }

      return jsonBad(res, "Failed to process uploaded shipment file.", {
        redirectUrl,
      });
    }
  }
);


router.get("/admin/offline-orders", authMiddleware, adminMiddleware, async (req: any, res) => {
  const q = norm(req.query.q || "");
  const status = norm(req.query.status || "all");
  const paymentMethod = norm(req.query.payment_method || "all");
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");

  const where: string[] = [`1=1`];
  const params: any[] = [];

  if (q) {
    where.push(`(
      au.name ILIKE $${params.length + 1}
      OR au.phone ILIKE $${params.length + 1}
      OR cu.name ILIKE $${params.length + 1}
      OR cu.phone ILIKE $${params.length + 1}
      OR ab.payment_id ILIKE $${params.length + 1}
    )`);
    params.push(`%${q}%`);
  }

  if (status !== "all") {
    where.push(`LOWER(COALESCE(ab.status,'draft')) = $${params.length + 1}`);
    params.push(status.toLowerCase());
  }

  if (paymentMethod !== "all") {
    where.push(`LOWER(COALESCE(ab.payment_method,'')) = $${params.length + 1}`);
    params.push(paymentMethod.toLowerCase());
  }

  if (dateFrom) {
    where.push(`ab.created_at >= $${params.length + 1}::timestamp`);
    params.push(dateFrom);
  }

  if (dateTo) {
    where.push(`ab.created_at < ($${params.length + 1}::timestamp + INTERVAL '1 day')`);
    params.push(dateTo);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const baseFromSql = `
    FROM agent_bookings ab
    JOIN users au ON au.id = ab.agent_user_id
    JOIN users cu ON cu.id = ab.customer_user_id
  `;

  const listQ = await pool.query(
    `
    SELECT
      ab.id,
      ab.created_at,
      ab.updated_at,
      ab.status,
      ab.payment_id,
      ab.payment_method,
      ab.delivery_mode,
      ab.total_amount,
      ab.bonus_book_count,
      ab.is_refunded,
      ab.refund_note,

      au.id AS agent_user_id,
      au.name AS agent_name,
      au.phone AS agent_phone,

      cu.id AS customer_user_id,
      cu.name AS customer_name,
      cu.phone AS customer_phone,

      COUNT(DISTINCT abl.id)::int AS line_count,
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles
    ${baseFromSql}
    LEFT JOIN agent_booking_lines abl ON abl.agent_booking_id = ab.id
    LEFT JOIN contests c ON c.id = abl.contest_id
    ${whereSql}
    GROUP BY
      ab.id, ab.created_at, ab.updated_at, ab.status, ab.payment_id,
      ab.payment_method, ab.delivery_mode, ab.total_amount, ab.bonus_book_count,
      ab.is_refunded, ab.refund_note,
      au.id, au.name, au.phone,
      cu.id, cu.name, cu.phone
    ORDER BY ab.created_at DESC
    LIMIT 500
    `,
    params
  );

  const summaryQ = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total_bookings,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' THEN ab.total_amount ELSE 0 END),0)::int AS paid_amount,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(ab.status,''))='paid')::int AS paid_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(ab.status,''))='checkout_pending')::int AS checkout_pending_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(ab.status,''))='draft')::int AS draft_count,
      COUNT(*) FILTER (WHERE COALESCE(ab.is_refunded,false)=true)::int AS refunded_count
    ${baseFromSql}
    ${whereSql}
    `,
    params
  );

  const byAgentQ = await pool.query(
    `
    SELECT
      au.id AS agent_user_id,
      au.name AS agent_name,
      au.phone AS agent_phone,
      COUNT(ab.id)::int AS bookings,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' THEN ab.total_amount ELSE 0 END),0)::int AS paid_amount
    ${baseFromSql}
    ${whereSql}
    GROUP BY au.id, au.name, au.phone
    ORDER BY paid_amount DESC, bookings DESC, au.name ASC
    `,
    params
  );

  const reportSummaryQ = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE LOWER(COALESCE(ab.status,''))='paid')::int AS paid_bookings,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' THEN ab.total_amount ELSE 0 END),0)::int AS total_paid_amount,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' AND LOWER(COALESCE(ab.payment_method,''))='cash' THEN ab.total_amount ELSE 0 END),0)::int AS cash_amount,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' AND LOWER(COALESCE(ab.payment_method,''))='phonepe' THEN ab.total_amount ELSE 0 END),0)::int AS phonepe_amount
    ${baseFromSql}
    ${whereSql}
    `,
    params
  );

  const bookSummaryQ = await pool.query(
    `
    SELECT
      x.book_kind,
      x.book_title,
      x.book_language,
      SUM(x.qty)::int AS qty
    FROM (
      SELECT
        'regular'::text AS book_kind,
        COALESCE(NULLIF(TRIM(abl.book_title),''), c.default_book_title, 'Book') AS book_title,
        COALESCE(NULLIF(TRIM(abl.book_language),''), '-') AS book_language,
        1::int AS qty
      FROM agent_bookings ab
      JOIN users au ON au.id = ab.agent_user_id
      JOIN users cu ON cu.id = ab.customer_user_id
      JOIN agent_booking_lines abl ON abl.agent_booking_id = ab.id
      JOIN contests c ON c.id = abl.contest_id
      ${whereSql}
        AND LOWER(COALESCE(ab.status,''))='paid'
        AND COALESCE(abl.line_status,'') <> 'cancelled'

      UNION ALL

      SELECT
        'bonus'::text AS book_kind,
        COALESCE(NULLIF(TRIM(abbi.book_title),''), 'Science of Self Realization') AS book_title,
        COALESCE(NULLIF(TRIM(abbi.book_language),''), '-') AS book_language,
        COALESCE(abbi.quantity, 1)::int AS qty
      FROM agent_bookings ab
      JOIN users au ON au.id = ab.agent_user_id
      JOIN users cu ON cu.id = ab.customer_user_id
      JOIN agent_booking_bonus_items abbi ON abbi.agent_booking_id = ab.id
      ${whereSql}
        AND LOWER(COALESCE(ab.status,''))='paid'
    ) x
    GROUP BY x.book_kind, x.book_title, x.book_language
    ORDER BY x.book_kind ASC, x.book_title ASC, x.book_language ASC
    `,
    params
  );

  const printRowsQ = await pool.query(
    `
    SELECT
      ab.id,
      TO_CHAR(
        ab.created_at AT TIME ZONE 'Asia/Kolkata',
        'DD/MM/YYYY HH12:MI AM'
      ) AS created_at,
      ab.payment_id,
      ab.payment_method,
      ab.total_amount,

      au.name AS agent_name,
      au.phone AS agent_phone,

      cu.name AS customer_name,
      cu.phone AS customer_phone,

      STRING_AGG(
        DISTINCT (
          COALESCE(NULLIF(TRIM(abl.book_title),''), c.default_book_title, 'Book')
          || ' - ' ||
          COALESCE(NULLIF(TRIM(abl.book_language),''), '-')
        ),
        ', '
        ORDER BY (
          COALESCE(NULLIF(TRIM(abl.book_title),''), c.default_book_title, 'Book')
          || ' - ' ||
          COALESCE(NULLIF(TRIM(abl.book_language),''), '-')
        )
      ) AS books_with_language,

      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles
    ${baseFromSql}
    LEFT JOIN agent_booking_lines abl ON abl.agent_booking_id = ab.id
    LEFT JOIN contests c ON c.id = abl.contest_id
    ${whereSql}
      AND LOWER(COALESCE(ab.status,''))='paid'
    GROUP BY
      ab.id, ab.created_at, ab.payment_id, ab.payment_method, ab.total_amount,
      au.name, au.phone,
      cu.name, cu.phone
    ORDER BY ab.created_at ASC, ab.id ASC
    `,
    params
  );

  const totalBooksQ = await pool.query(
    `
    SELECT COALESCE(SUM(x.qty),0)::int AS total_books
    FROM (
      SELECT 1::int AS qty
      FROM agent_bookings ab
      JOIN users au ON au.id = ab.agent_user_id
      JOIN users cu ON cu.id = ab.customer_user_id
      JOIN agent_booking_lines abl ON abl.agent_booking_id = ab.id
      ${whereSql}
        AND LOWER(COALESCE(ab.status,''))='paid'
        AND COALESCE(abl.line_status,'') <> 'cancelled'

      UNION ALL

      SELECT COALESCE(abbi.quantity,1)::int AS qty
      FROM agent_bookings ab
      JOIN users au ON au.id = ab.agent_user_id
      JOIN users cu ON cu.id = ab.customer_user_id
      JOIN agent_booking_bonus_items abbi ON abbi.agent_booking_id = ab.id
      ${whereSql}
        AND LOWER(COALESCE(ab.status,''))='paid'
    ) x
    `,
    params
  );

  res.render("admin/admin-offline-orders", {
  activeTab: "offline-orders",
  items: listQ.rows,
  summary: summaryQ.rows[0],
  byAgent: byAgentQ.rows,
  reportSummary: reportSummaryQ.rows[0] || {
    paid_bookings: 0,
    total_paid_amount: 0,
    cash_amount: 0,
    phonepe_amount: 0
  },
  bookSummary: bookSummaryQ.rows || [],
  printRows: printRowsQ.rows || [],
  totalBooks: totalBooksQ.rows[0]?.total_books || 0,
  filters: { q, status, paymentMethod, dateFrom, dateTo },
  qs: qsOf(req),

  // 🔥 THIS WAS MISSING
  okMsg: norm(req.query.okMsg || ""),
  errMsg: norm(req.query.errMsg || ""),
});
});


router.post("/admin/offline-orders/assign-agent", authMiddleware, adminMiddleware, async (req: any, res) => {
  const returnQs = norm(req.body.return_qs || "");
  const backTo = `/admin/offline-orders${returnQs ? `?${returnQs}` : ""}`;
  const joiner = backTo.includes("?") ? "&" : "?";

  const bookingIdsRaw = Array.isArray(req.body.booking_ids)
    ? req.body.booking_ids
    : [req.body.booking_ids];

  const bookingIds = Array.from(
    new Set(
      bookingIdsRaw
        .map((v: any) => String(v || "").trim())
        .filter(Boolean)
    )
  );

  const targetAgentPhone = String(req.body.target_agent_phone || "")
    .replace(/\D/g, "")
    .slice(-10);

  if (!bookingIds.length) {
    return res.redirect(
      `${backTo}${joiner}errMsg=${encodeURIComponent("Please select at least one booking.")}`
    );
  }

  if (!/^[6-9]\d{9}$/.test(targetAgentPhone)) {
    return res.redirect(
      `${backTo}${joiner}errMsg=${encodeURIComponent("Please enter a valid 10-digit agent mobile number.")}`
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const targetAgentQ = await client.query(
      `
      SELECT id, name, phone
      FROM users
      WHERE phone = $1
        AND LOWER(COALESCE(role,'')) = 'agent'
      LIMIT 1
      `,
      [targetAgentPhone]
    );

    if (!targetAgentQ.rows.length) {
      throw new Error("No agent account found for the entered mobile number.");
    }

    const targetAgent = targetAgentQ.rows[0];

    const selectedQ = await client.query(
      `
      SELECT id, agent_user_id
      FROM agent_bookings
      WHERE id = ANY($1::uuid[])
      `,
      [bookingIds]
    );

    if (selectedQ.rows.length !== bookingIds.length) {
      throw new Error("Some selected bookings were not found. Please refresh and try again.");
    }

    const updateQ = await client.query(
      `
      UPDATE agent_bookings
      SET agent_user_id = $1,
          updated_at = NOW()
      WHERE id = ANY($2::uuid[])
      RETURNING id
      `,
      [targetAgent.id, bookingIds]
    );

    await client.query("COMMIT");

    return res.redirect(
      `${backTo}${joiner}okMsg=${encodeURIComponent(
        `Assigned ${updateQ.rowCount || 0} booking(s) to ${targetAgent.name} (${targetAgent.phone}).`
      )}`
    );
  } catch (e: any) {
    await client.query("ROLLBACK");
    return res.redirect(
      `${backTo}${joiner}errMsg=${encodeURIComponent(
        e?.message || "Failed to assign selected bookings."
      )}`
    );
  } finally {
    client.release();
  }
});


// ─── BOOK EDIT ROUTES ────────────────────────────────────────────────────────
// Add these two routes just before `export default router;` in admin.ts

// GET /admin/shipments/:shipmentId/book-edit-data
// Returns current shipment_items, shipment_bonus_items, and full stock map
// Used by the admin modal to pre-populate selects with existing data
router.get(
  "/admin/shipments/:shipmentId/book-edit-data",
  authMiddleware,
  adminMiddleware,
  async (req: any, res) => {
    try {
      const shipmentId = norm(req.params.shipmentId || "");
      if (!shipmentId) return res.status(400).json({ error: "Missing shipmentId" });

      // Verify shipment exists and get its status — block edit if dispatched or beyond
      const shipQ = await pool.query(
        `SELECT id, status, delivery_mode FROM shipments WHERE id=$1 LIMIT 1`,
        [shipmentId]
      );
      if (!shipQ.rows.length) return res.status(404).json({ error: "Shipment not found" });

      const shipStatus = String(shipQ.rows[0].status || "").toLowerCase();
      const blockedStatuses = new Set(["dispatched", "delivered", "returned", "handed_over"]);
      if (blockedStatuses.has(shipStatus)) {
        return res.status(400).json({
          error: `Cannot edit books for a shipment in "${shipStatus}" status.`,
        });
      }

      // Fetch existing shipment_items (regular books)
      const itemsQ = await pool.query(
        `SELECT si.id, si.order_id, si.book_title, si.book_language
         FROM shipment_items si
         WHERE si.shipment_id = $1
         ORDER BY si.created_at ASC, si.id ASC`,
        [shipmentId]
      );

      // Fetch existing shipment_bonus_items
      const bonusQ = await pool.query(
        `SELECT id, book_title, book_language, quantity
         FROM shipment_bonus_items
         WHERE shipment_id = $1
         ORDER BY created_at ASC, id ASC`,
        [shipmentId]
      );

      // Fetch available stock (same logic as checkout.ts fetchAvailableBookLanguages)
      const stockQ = await pool.query(
        `SELECT TRIM(book_title) AS book_title, TRIM(book_language) AS book_language
         FROM shipment_book_stock
         WHERE COALESCE(stock_qty, 0) > 0
           AND COALESCE(TRIM(book_title), '') <> ''
           AND COALESCE(TRIM(book_language), '') <> ''
         ORDER BY book_title ASC, book_language ASC`
      );

      // Build map: { "Ramayana": ["Telugu","Hindi",...], ... }
      const stockMap: Record<string, string[]> = {};
      for (const row of stockQ.rows) {
        const title = String(row.book_title || "").trim();
        const lang = String(row.book_language || "").trim();
        if (!title || !lang) continue;
        if (!stockMap[title]) stockMap[title] = [];
        if (!stockMap[title].includes(lang)) stockMap[title].push(lang);
      }

      return res.json({
        shipmentId,
        status: shipStatus,
        items: itemsQ.rows,        // regular books
        bonusItems: bonusQ.rows,   // bonus books
        stockMap,                  // available titles + languages
      });
    } catch (e) {
      console.error("book-edit-data error:", e);
      return res.status(500).json({ error: "Failed to load book edit data." });
    }
  }
);

// POST /admin/shipments/:shipmentId/update-books
// Updates shipment_items and shipment_bonus_items in one transaction
// Body: { items: [{id, book_title, book_language}], bonusItems: [{id, book_title, book_language}] }
router.post(
  "/admin/shipments/:shipmentId/update-books",
  authMiddleware,
  adminMiddleware,
  async (req: any, res) => {
    try {
      const shipmentId = norm(req.params.shipmentId || "");
      if (!shipmentId) return res.status(400).json({ error: "Missing shipmentId" });

      // Verify shipment exists and is still editable
      const shipQ = await pool.query(
        `SELECT id, status FROM shipments WHERE id=$1 LIMIT 1`,
        [shipmentId]
      );
      if (!shipQ.rows.length) return res.status(404).json({ error: "Shipment not found" });

      const shipStatus = String(shipQ.rows[0].status || "").toLowerCase();
      const blockedStatuses = new Set(["dispatched", "delivered", "returned", "handed_over"]);
      if (blockedStatuses.has(shipStatus)) {
        return res.status(400).json({
          error: `Cannot edit books for a shipment in "${shipStatus}" status.`,
        });
      }

      const items: Array<{ id: string; book_title: string; book_language: string }> =
        Array.isArray(req.body.items) ? req.body.items : [];
      const bonusItems: Array<{ id: string; book_title: string; book_language: string }> =
        Array.isArray(req.body.bonusItems) ? req.body.bonusItems : [];

      // Validate — every item must have id, book_title, book_language
      for (const it of items) {
        if (!norm(it.id) || !norm(it.book_title) || !norm(it.book_language)) {
          return res.status(400).json({ error: "Each item must have id, book_title, book_language." });
        }
      }
      for (const bi of bonusItems) {
        if (!norm(bi.id) || !norm(bi.book_title) || !norm(bi.book_language)) {
          return res.status(400).json({ error: "Each bonus item must have id, book_title, book_language." });
        }
      }

      await pool.query("BEGIN");
      try {
        // Update each shipment_item — only rows that belong to this shipment (security check via WHERE)
        for (const it of items) {
          await pool.query(
            `UPDATE shipment_items
             SET book_title=$1, book_language=$2
             WHERE id=$3 AND shipment_id=$4`,
            [norm(it.book_title), norm(it.book_language), norm(it.id), shipmentId]
          );
        }

        // Update each shipment_bonus_item
        for (const bi of bonusItems) {
          await pool.query(
            `UPDATE shipment_bonus_items
             SET book_title=$1, book_language=$2
             WHERE id=$3 AND shipment_id=$4`,
            [norm(bi.book_title), norm(bi.book_language), norm(bi.id), shipmentId]
          );
        }

        await pool.query("COMMIT");
        return res.json({ ok: true });
      } catch (dbErr) {
        await pool.query("ROLLBACK");
        throw dbErr;
      }
    } catch (e) {
      console.error("update-books error:", e);
      return res.status(500).json({ error: "Failed to update books." });
    }
  }
);
// ─────────────────────────────────────────────────────────────────────────────

export default router;
