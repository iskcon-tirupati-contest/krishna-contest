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
import { sendContestRegistrationMessageOnce } from "../services/contestConfirmation";
import { hashPassword } from "../utils/hash";

const router = express.Router();

const toInt = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const norm = (v: any) => String(v ?? "").trim();
const normLike = (v: any) => `%${norm(v)}%`;

const upload = multer({ dest: path.join(process.cwd(), "tmp") });


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
      STRING_AGG(DISTINCT c.title, ', ' ORDER BY c.title) AS contest_titles,

      STRING_AGG(
        DISTINCT (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, '')),
        ', ' ORDER BY (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, ''))
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
          DISTINCT (COALESCE(sbi.book_title, '') || '-' || COALESCE(sbi.book_language, '')),
          ', ' ORDER BY (COALESCE(sbi.book_title, '') || '-' || COALESCE(sbi.book_language, ''))
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
  const dateFrom = norm(req.query.date_from || "");
  const dateTo = norm(req.query.date_to || "");
  const onDate = norm(req.query.on_date || "");

  //const where: string[] = [];
  const where: string[] = [onlineOrdersWhere("o")];
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
  onlineOrdersWhere("o")
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
  return { whereSql, params, filters: { q, status, dateFrom, dateTo,deliveryMode } };
}


router.get("/admin/shipments", authMiddleware, adminMiddleware, async (req: any, res) => {
  const { whereSql, params, filters } = buildShipmentsFilter(req);

  const items = await fetchShipmentCsvRows(req);

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
    items,
    contests: contestsQ.rows,
    filters,
    statusFacets: statusCounts.rows,
    qs: qsOf(req),
    imported: norm(req.query.imported || ""),
    errorMsg: norm(req.query.errorMsg || ""),
    okMsg: norm(req.query.okMsg || ""),
    validationErrors: [],
  });
});

router.get("/admin/shipments/export.csv", authMiddleware, adminMiddleware, async (req: any, res) => {
  const rows = await fetchShipmentCsvRows(req);

  const header = [
    "SHIPMENT_ID",
    "PAYMENT_ID",
    "USER_NAME",
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "CITY",
    "STATE",
    "PINCODE",
    "REGULAR_BOOKS_WITH_LANGUAGE",
    "BONUS_BOOKS_WITH_LANGUAGE",
    "ALL_BOOKS_WITH_LANGUAGE",
    "TRACKING_ID",
    "COURIER_MODE",
    "DELIVERY_MODE",
    "STATUS"
  ];

  const lines = [header.map(csvEscape).join(",")];

  for (const r of rows) {
    lines.push([
      r.shipment_id,
      r.payment_id || "",
      r.user_name || "",
      r.email || "",
      r.phone || "",
      r.address || "",
      r.city || "",
      r.state || "",
      r.pincode || "",
      r.regular_books_with_language || "",
      r.bonus_books_with_language || "",
      r.books_display || "",
      r.tracking_id || "",
      r.courier_mode || "",
      r.delivery_mode || "",
      r.status || "",
    ].map(csvEscape).join(","));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="shipments-export.csv"`);
  return res.send(lines.join("\n"));
});



router.post("/admin/shipments/update", authMiddleware, adminMiddleware, async (req: any, res) => {
  const shipmentId = norm(req.body.shipmentId);
  const trackingId = norm(req.body.tracking_id);
  let courierMode = norm(req.body.courier_mode);
  let status = norm(req.body.status || "pending").toLowerCase();

  if (!shipmentId) return res.redirect("/admin/shipments");

  const allowedStatuses = new Set(["pending", "packed", "dispatched", "delivered", "handed_over"]);
  if (!allowedStatuses.has(status)) status = "pending";

  const shipQ = await pool.query(
    `SELECT delivery_mode, courier_mode FROM shipments WHERE id=$1 LIMIT 1`,
    [shipmentId]
  );

  const deliveryMode = String(shipQ.rows[0]?.delivery_mode || "").toLowerCase();
  const existingCourier = norm(shipQ.rows[0]?.courier_mode || "");

  if (status === "handed_over") {
    courierMode = courierMode || existingCourier || "temple_handover";
  } else if (status === "delivered") {
    courierMode = courierMode || existingCourier || "admin_marked_delivered";
  }

  await pool.query(
    `UPDATE shipments
     SET tracking_id=$1, courier_mode=$2, status=$3, updated_at=NOW()
     WHERE id=$4`,
    [trackingId || null, courierMode || null, status, shipmentId]
  );

  res.redirect("/admin/shipments");
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

    const csv = [
      header.join(","),
      ...rows.map(r => [
        r.shipment_id,
        csvEscape(r.user_name),
        r.phone,
        csvEscape(r.address),
        r.city,
        r.state,
        r.pincode,
        csvEscape(r.books_with_language),
        "" // blank for packing team
      ].join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=missing_tracking.csv");
    res.send(csv);
  }
);

router.post(
  "/admin/shipments/import-csv",
  authMiddleware,
  adminMiddleware,
  upload.single("result_file"),
  async (req: any, res) => {
    try {
      if (!req.file?.path) {
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Please choose a CSV file."));
      }

      const wb = XLSX.readFile(req.file.path, { raw: false });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" }) as any[];

      if (!rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("CSV file is empty."));
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
        return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("No shipment ids found in CSV."));
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
            DISTINCT (COALESCE(si.book_title, '') || '-' || COALESCE(si.book_language, '')),
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
              DISTINCT (COALESCE(sbi.book_title, '') || '-' || COALESCE(sbi.book_language, '')),
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
  const courierMode = normalizeCell(row["COURIER_MODE"]) || "csv_upload";

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
      encodeURIComponent("CSV validation failed: " + errors.slice(0, 12).join(" | "))
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
      return res.redirect("/admin/shipments?errorMsg=" + encodeURIComponent("Failed to import shipment CSV."));
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
            encodeURIComponent("Please choose a CSV/XLSX file.")
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
    FROM agent_bookings ab
    JOIN users au ON au.id = ab.agent_user_id
    JOIN users cu ON cu.id = ab.customer_user_id
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
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,''))='paid' THEN total_amount ELSE 0 END),0)::int AS paid_amount,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status,''))='paid')::int AS paid_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status,''))='checkout_pending')::int AS checkout_pending_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status,''))='draft')::int AS draft_count,
      COUNT(*) FILTER (WHERE COALESCE(is_refunded,false)=true)::int AS refunded_count
    FROM agent_bookings ab
    ${whereSql}
    `,
    params
  );

  const byAgentQ = await pool.query(
    `
    SELECT
      au.name AS agent_name,
      COUNT(ab.id)::int AS bookings,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(ab.status,''))='paid' THEN ab.total_amount ELSE 0 END),0)::int AS paid_amount
    FROM agent_bookings ab
    JOIN users au ON au.id = ab.agent_user_id
    JOIN users cu ON cu.id = ab.customer_user_id
    ${whereSql}
    GROUP BY au.name
    ORDER BY paid_amount DESC, bookings DESC, au.name ASC
    `,
    params
  );

  res.render("admin/admin-offline-orders", {
    activeTab: "offline-orders",
    items: listQ.rows,
    summary: summaryQ.rows[0],
    byAgent: byAgentQ.rows,
    filters: { q, status, paymentMethod, dateFrom, dateTo },
    qs: qsOf(req),
  });
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

export default router;

