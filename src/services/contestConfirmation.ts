import https from "https";
import { pool } from "../config/db";

type ContestConfirmationInput = {
  paymentId: string;
  paymentSessionId: string | null;
  userId: string;
  phone: string;
  userName: string;
  contestTitles: string[];
};

type OfflineContestConfirmationInput = ContestConfirmationInput & {
  loginHelpText: string;
};

function normPhone(v: string) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

function mnvPost(payload: any): Promise<any> {
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
          const status = res.statusCode || 0;
          let json: any = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }

          if (status >= 200 && status < 300) {
            return resolve(json);
          }

          return reject(
            new Error(`MNV send failed: ${status} ${typeof data === "string" ? data.slice(0, 300) : ""}`)
          );
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function sendContestRegistrationMessageOnce(input: ContestConfirmationInput) {
  const paymentId = String(input.paymentId || "").trim();
  const paymentSessionId = input.paymentSessionId || null;
  const userId = String(input.userId || "").trim();
  const phone = normPhone(input.phone);
  const userName = String(input.userName || "Participant").trim() || "Participant";

  if (!paymentId || !userId || !phone) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  // 1) If already logged, skip immediately
  const existing = await pool.query(
    `
    SELECT id
    FROM whatsapp_message_logs
    WHERE payment_id = $1
      AND message_type = 'contest_registration_success'
    LIMIT 1
    `,
    [paymentId]
  );

  if (existing.rows.length > 0) {
    return { ok: true, skipped: true, reason: "already_sent" as const };
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_CONTEST_CONFIRM_CAMPAIGN_NAME || "contest_registration_success"
  ).trim();
  const source = String(
    process.env.MNV_CONTEST_CONFIRM_SOURCE || "contest-registration-success"
  ).trim();
  const senderName = String(
    process.env.MNV_CONTEST_CONFIRM_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;
  const contestList = (input.contestTitles || []).filter(Boolean).join(", ") || "Contest registration";
  const contestCount = (input.contestTitles || []).filter(Boolean).length;

  // Assumes your approved utility template uses:
  // {{1}} -> participant name
  // {{2}} -> payment id
  // {{3}} -> contest count
  // {{4}} -> contest titles
  const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams: [
      userName,
      paymentId,
      String(contestCount),
      contestList,
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {},
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "Unknown send failure";
  }

  // 2) Insert log exactly once (unique index protects duplicate sends)
  try {
    await pool.query(
      `
      INSERT INTO whatsapp_message_logs
        (payment_id, payment_session_id, user_id, phone, message_type, provider, provider_message_id, status, response_text)
      VALUES
        ($1,$2,$3,$4,'contest_registration_success','mnv_whatsapp',$5,$6,$7)
      `,
      [paymentId, paymentSessionId, userId, phone, providerMessageId, sendStatus, responseText]
    );
  } catch (e: any) {
    // If duplicate unique hit, treat as already sent/handled
    if (String(e?.code || "") === "23505") {
      return { ok: true, skipped: true, reason: "already_logged_by_parallel_request" as const };
    }
    throw e;
  }

  return {
    ok: sendStatus === "sent",
    skipped: false,
    status: sendStatus,
    providerMessageId,
  };
}

export async function sendOfflineRegistrationMessageOnce(input: OfflineContestConfirmationInput) {
  const loginHelpText = String(input.loginHelpText || "").trim();
  const paymentId = String(input.paymentId || "").trim();
  const paymentSessionId = input.paymentSessionId || null;
  const userId = String(input.userId || "").trim();
  const phone = normPhone(input.phone);
  const userName = String(input.userName || "Participant").trim() || "Participant";

  if (!paymentId || !userId || !phone) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  const existing = await pool.query(
    `
    SELECT id
    FROM whatsapp_message_logs
    WHERE payment_id = $1
      AND message_type = 'offline_registration_success'
    LIMIT 1
    `,
    [paymentId]
  );

  if (existing.rows.length > 0) {
    return { ok: true, skipped: true, reason: "already_sent" as const };
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_OFFLINE_CONFIRM_CAMPAIGN_NAME || "offline_success"
  ).trim();
  const source = String(
    process.env.MNV_OFFLINE_CONFIRM_SOURCE || "offline-registration-success"
  ).trim();
  const senderName = String(
    process.env.MNV_OFFLINE_CONFIRM_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;
  const contestList = (input.contestTitles || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join(", ") || "Contest registration";

  const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams: [
      userName,    // {{1}}
      phone,    // {{2}}
      paymentId,  //{{3}}
      contestList, // {{4}} contest details
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {},
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "Unknown send failure";
  }

  try {
    await pool.query(
      `
      INSERT INTO whatsapp_message_logs
        (payment_id, payment_session_id, user_id, phone, message_type, provider, provider_message_id, status, response_text)
      VALUES
        ($1,$2,$3,$4,'offline_registration_success','mnv_whatsapp',$5,$6,$7)
      `,
      [paymentId, paymentSessionId, userId, phone, providerMessageId, sendStatus, responseText]
    );
  } catch (e: any) {
    if (String(e?.code || "") === "23505") {
      return { ok: true, skipped: true, reason: "already_logged_by_parallel_request" as const };
    }
    throw e;
  }

  return {
    ok: sendStatus === "sent",
    skipped: false,
    status: sendStatus,
    providerMessageId,
  };
}

type ShipmentDispatchConfirmationInput = {
  paymentId: string;
  paymentSessionId: string | null;
  userId: string;
  phone: string;
  userName: string;
  trackingId: string;
};

export async function sendShipmentDispatchMessageOnce(input: ShipmentDispatchConfirmationInput) {
  const paymentId = String(input.paymentId || "").trim();
  const paymentSessionId = input.paymentSessionId || null;
  const userId = String(input.userId || "").trim();
  const phone = normPhone(input.phone);
  const userName = String(input.userName || "Participant").trim() || "Participant";
  const trackingId = String(input.trackingId || "").trim();

  if (!paymentId || !userId || !phone || !trackingId) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  const existing = await pool.query(
    `
    SELECT id
    FROM whatsapp_message_logs
    WHERE payment_id = $1
      AND message_type = 'shipment_dispatch_success'
    LIMIT 1
    `,
    [paymentId]
  );

  if (existing.rows.length > 0) {
    return { ok: true, skipped: true, reason: "already_sent" as const };
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_SHIPMENT_DISPATCH_CAMPAIGN_NAME || "Dispatch_success"
  ).trim();
  const source = String(
    process.env.MNV_SHIPMENT_DISPATCH_SOURCE || "shipment-dispatch-success"
  ).trim();
  const senderName = String(
    process.env.MNV_SHIPMENT_DISPATCH_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;

  const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams: [
      trackingId, // {{1}}
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {
      paymentId,
      userId,
      messageType: "shipment_dispatch_success",
    },
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "Unknown send failure";
  }

  try {
    await pool.query(
      `
      INSERT INTO whatsapp_message_logs
        (payment_id, payment_session_id, user_id, phone, message_type, provider, provider_message_id, status, response_text)
      VALUES
        ($1,$2,$3,$4,'shipment_dispatch_success','mnv_whatsapp',$5,$6,$7)
      `,
      [paymentId, paymentSessionId, userId, phone, providerMessageId, sendStatus, responseText]
    );
  } catch (e: any) {
    if (String(e?.code || "") === "23505") {
      return { ok: true, skipped: true, reason: "already_logged_by_parallel_request" as const };
    }
    throw e;
  }

  return {
    ok: sendStatus === "sent",
    skipped: false,
    status: sendStatus,
    providerMessageId,
  };
}

type CampaignContestConfirmationInput = {
  paymentId: string;
  paymentSessionId: string | null;
  userId: string;
  phone: string;
  userName: string;
  contestTitle: string;
  loginHelpText: string;
};

export async function sendCampaignRegistrationMessageOnce(input: CampaignContestConfirmationInput) {
  console.log("============== sendCampaignRegistrationMessageOnce ================>")
  const loginHelpText = String(input.loginHelpText || "").trim();
  const paymentId = String(input.paymentId || "").trim();
  const paymentSessionId = input.paymentSessionId || null;
  const userId = String(input.userId || "").trim();
  const phone = normPhone(input.phone);
  const userName = String(input.userName || "Participant").trim() || "Participant";
  const contestTitle = String(input.contestTitle || "Ramayana Essay Writing Contest").trim();

  if (!paymentId || !userId || !phone) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  const existing = await pool.query(
    `
    SELECT id
    FROM whatsapp_message_logs
    WHERE payment_id = $1
      AND message_type = 'campaign_registration_success'
    LIMIT 1
    `,
    [paymentId]
  );

  if (existing.rows.length > 0) {
    return { ok: true, skipped: true, reason: "already_sent" as const };
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_CAMPAIGN_CONFIRM_CAMPAIGN_NAME || "form_registration_success"
  ).trim();
  const source = String(
    process.env.MNV_CAMPAIGN_CONFIRM_SOURCE || "form-registration-success"
  ).trim();
  const senderName = String(
    process.env.MNV_CAMPAIGN_CONFIRM_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;

    const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams: [
      userName,
      phone,
      paymentId,
      contestTitle,
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {
      paymentId,
      userId,
      messageType: "campaign_registration_success",
    },
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "Unknown send failure";
  }

  try {
    await pool.query(
      `
      INSERT INTO whatsapp_message_logs
        (payment_id, payment_session_id, user_id, phone, message_type, provider, provider_message_id, status, response_text)
      VALUES
        ($1,$2,$3,$4,'campaign_registration_success','mnv_whatsapp',$5,$6,$7)
      `,
      [paymentId, paymentSessionId, userId, phone, providerMessageId, sendStatus, responseText]
    );
  } catch (e: any) {
    if (String(e?.code || "") === "23505") {
      return { ok: true, skipped: true, reason: "already_logged_by_parallel_request" as const };
    }
    throw e;
  }

  return {
    ok: sendStatus === "sent",
    skipped: false,
    status: sendStatus,
    providerMessageId,
  };
}


type IvrRegistrationLinkInput = {
  phone: string;
};

export async function sendIvrRegistrationLinkMessage(input: IvrRegistrationLinkInput) {
  const phone = normPhone(input.phone);

  if (!phone) {
    return { ok: false, skipped: true, reason: "missing_required_fields" as const };
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(
    process.env.MNV_IVR_REGISTRATION_CAMPAIGN_NAME || "ivr_registration_link"
  ).trim();
  const source = String(
    process.env.MNV_IVR_REGISTRATION_SOURCE || "ivr-registration-link"
  ).trim();
  const senderName = String(
    process.env.MNV_IVR_REGISTRATION_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;

  const payload = {
    apiKey,
    campaignName,
    destination,
    userName: senderName,
    templateParams: [],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: {
      messageType: "ivr_registration_link",
      phone,
    },
  };

  let providerMessageId: string | null = null;
  let responseText = "";
  let sendStatus: "sent" | "failed" = "sent";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId =
      response?.submitted_message_id ||
      response?.message_id ||
      response?.id ||
      null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "Unknown send failure";
  }

  return {
    ok: sendStatus === "sent",
    skipped: false,
    status: sendStatus,
    providerMessageId,
    responseText,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// IVR FUNCTIONS — appended to contestConfirmation.ts
// ─────────────────────────────────────────────────────────────────────────────

// ── IVR Option 1-5: Contest Registration Link ────────────────────────────────
// Single shared template: ivr_registration_request
// {{1}} = contest name, {{2}} = registration URL

type IvrContestCategory = "ramayana" | "bhagavatam" | "krishna" | "gita" | "combo";

const CONTEST_LABELS: Record<IvrContestCategory, string> = {
  ramayana:   "Ramayana essay writing contest",
  bhagavatam: "Bhagavatam essay writing contest",
  krishna:    "Krishna essay writing contest",
  gita:       "Bhagavad Gita essay writing contest",
  combo:      "All 4 essay writing contests (Combo)",
};

export async function sendIvrContestLinkMessage(phone: string, category: IvrContestCategory) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  // Single campaign for all 5 contest options
  const campaignName = String(process.env.MNV_IVR_CONTEST_CAMPAIGN_NAME || "eng_reg_request").trim();
  const source = String(process.env.MNV_IVR_CONTEST_SOURCE || "eng-reg-request").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  // Dev uses iskconcontest.org — swap to iskconcontest.org via SITE_BASE_URL in production
  const baseUrl = String(process.env.SITE_BASE_URL || "https://iskconcontest.org").trim();
  const registrationUrl = `${baseUrl}/join/${category}`;

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [
      registrationUrl,           // {{2}} registration URL
      CONTEST_LABELS[category],  // {{1}} contest name

    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: `ivr_${category}_link`, phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── IVR Option 6: Book Tracking ──────────────────────────────────────────────

type ShipmentRow = {
  shipment_id: string;
  payment_id: string;
  status: string;
  tracking_id: string | null;
  books_with_language: string; // e.g. "Ramayana - Telugu, Bhagavad Gita - Hindi"
};

export async function sendIvrBookTrackingMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  // 1) Lookup user by phone (users table is primary)
  const userQ = await pool.query(
    `SELECT id, name FROM users WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  if (!userQ.rows.length) {
    return sendIvrNotRegisteredMessage(normalized);
  }

  const user = userQ.rows[0];

  // 2) Fetch paid shipments — same logic as admin fetchShipmentCsvRows
  // STRING_AGG ordered by si.id (insertion order), no DISTINCT — duplicates intentional
  const shipmentsQ = await pool.query(
    `SELECT
       s.id AS shipment_id,
       s.payment_id,
       s.status,
       s.tracking_id,
       STRING_AGG(
         (COALESCE(si.book_title, '') || ' - ' || COALESCE(si.book_language, '')),
         ', ' ORDER BY si.id
       ) AS books_with_language
     FROM shipments s
     JOIN shipment_items si ON si.shipment_id = s.id
     JOIN orders o ON o.id = si.order_id
     WHERE o.user_id = $1
       AND o.payment_status = 'paid'
     GROUP BY s.id, s.payment_id, s.status, s.tracking_id
     ORDER BY s.id DESC
     LIMIT 3`,
    [user.id]
  );

  if (!shipmentsQ.rows.length) {
    // User is registered but no paid shipments — use ivr_track_order template with "no orders" message
    console.log(`IVR BOOK_TRACKING: phone=${normalized} registered but no paid shipments`);

    const apiKey2 = String(process.env.MNV_API_KEY || "").trim();
    const campaignName2 = String(process.env.MNV_IVR_TRACKING_CAMPAIGN_NAME || "").trim();
    const source2 = String(process.env.MNV_IVR_TRACKING_SOURCE || "ivr-book-tracking").trim();
    const senderName2 = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

    if (!apiKey2 || !campaignName2) return { ok: false, reason: "provider_not_configured" };

    const noShipmentPayload = {
      apiKey: apiKey2,
      campaignName: campaignName2,
      destination: `91${normalized}`,
      userName: senderName2,
      templateParams: [
        String(user.name || "Participant").trim(),  // {{1}} name
        "No shipments found for your account.",     // {{2}} summary
      ],
      source: source2,
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: { messageType: "ivr_no_shipments", phone: normalized },
    };

    try {
      const response = await mnvPost(noShipmentPayload);
      const responseText = typeof response === "string" ? response : JSON.stringify(response || {});
      console.log(`IVR NO_SHIPMENTS: phone=${normalized} responseText=${responseText}`);
      return { ok: true, providerMessageId: response?.submitted_message_id || null };
    } catch (e: any) {
      console.error(`IVR NO_SHIPMENTS: phone=${normalized} failed:`, e?.message);
      return { ok: false, reason: e?.message };
    }
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TRACKING_CAMPAIGN_NAME || "").trim();
  const source = String(process.env.MNV_IVR_TRACKING_SOURCE || "ivr-book-tracking").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  // Build single-line summary — no \n allowed in Meta template params
  // Format: "1. Ramayana - Telugu, Bhagavad Gita - Hindi - Pending | 2. Krishna Book - Kannada - Dispatched TrackID:EW123IN"
  const summaryLines = shipmentsQ.rows.map((s: any, idx: number) => {
    const statusLabel =
      s.status === "pending"         ? "Pending"
      : s.status === "under_packing" ? "Packing"
      : s.status === "packed"        ? "Packed"
      : s.status === "dispatched"    ? "Dispatched"
      : s.status === "delivered"     ? "Delivered"
      : s.status === "returned"      ? "Returned"
      : s.status === "cancelled"     ? "Cancelled"
      : String(s.status || "").replace(/_/g, " ");

    const books = (s.books_with_language || "Books").trim();
    const tracking = s.tracking_id ? ` TrackID:${s.tracking_id}` : "";
    return `${idx + 1}. ${books} - ${statusLabel}${tracking}`;
  });

  const hasTracking = shipmentsQ.rows.some((s: any) => s.tracking_id);
  const indiaPostLink = hasTracking ? " | Track: https://www.indiapost.gov.in" : "";
  const summary = summaryLines.join(" | ") + indiaPostLink;
  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [
      String(user.name || "Participant").trim(),  // {{1}} name
      summary,                                     // {{2}} order summary
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_book_tracking", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

async function sendIvrNotRegisteredMessage(phone: string) {
  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_NOT_REGISTERED_CAMPAIGN_NAME || "").trim();
  const source = String(process.env.MNV_IVR_NOT_REGISTERED_SOURCE || "ivr-not-registered").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  console.log(`IVR NOT_REGISTERED: phone=${phone} campaign=${campaignName}`);

  if (!apiKey || !campaignName) {
    console.warn(`IVR NOT_REGISTERED: provider_not_configured — check MNV_API_KEY and MNV_IVR_NOT_REGISTERED_CAMPAIGN_NAME in .env`);
    return { ok: false, reason: "provider_not_configured" };
  }

  const payload = {
    apiKey,
    campaignName,
    destination: `91${phone}`,
    userName: senderName,
    templateParams: [],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_not_registered", phone },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  console.log(`IVR NOT_REGISTERED: phone=${phone} status=${sendStatus} responseText=${responseText}`);
  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── IVR Option 7: Essay Submission Help ───────────────────────────────────────

export async function sendIvrEssayHelpMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_ESSAY_HELP_CAMPAIGN_NAME || "").trim();
  const source = String(process.env.MNV_IVR_ESSAY_HELP_SOURCE || "ivr-essay-help").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  // Template sends the essay submission guide — no dynamic params, video baked in template
  // If MNV template has {{1}}, pass empty string to satisfy param count
  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [],  // ivr_submission template has no params — video URL baked in template body
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_essay_help", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── IVR Option 8: Raise a Complaint ──────────────────────────────────────────

export async function sendIvrComplaintMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_COMPLAINT_CAMPAIGN_NAME || "").trim();
  const source = String(process.env.MNV_IVR_COMPLAINT_SOURCE || "ivr-complaint").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  // Template: "Please fill this form to raise your complaint: {{1}}"
  // {{1}} = complaint form URL
  const complaintFormUrl = String(process.env.COMPLAINT_FORM_URL || "https://iskconcontest.org/complaint").trim();

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [complaintFormUrl],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_complaint", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}
// ─────────────────────────────────────────────────────────────────────────────
// TELUGU IVR FUNCTIONS
// Same logic as English versions — just different MNV campaign names (Telugu templates)
// ─────────────────────────────────────────────────────────────────────────────

// ── Telugu Option 1-5: Contest Registration Link ─────────────────────────────

const CONTEST_LABELS_TE: Record<IvrContestCategory, string> = {
  ramayana:   "రామాయణ వ్యాస పోటీ",
  bhagavatam: "భాగవతం వ్యాస పోటీ",
  krishna:    "కృష్ణ వ్యాస పోటీ",
  gita:       "భగవద్గీత వ్యాస పోటీ",
  combo:      "నాలుగు వ్యాస పోటీలు (కాంబో)",
};

export async function sendIvrTeluguContestLinkMessage(phone: string, category: IvrContestCategory) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TE_CONTEST_CAMPAIGN_NAME || "ivr_registration_request_te").trim();
  const source = String(process.env.MNV_IVR_TE_CONTEST_SOURCE || "ivr-registration-request-te").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  const baseUrl = String(process.env.SITE_BASE_URL || "https://iskconcontest.org").trim();
  const registrationUrl = `${baseUrl}/join/${category}`;

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [
      CONTEST_LABELS_TE[category],  // {{1}} contest name in Telugu
      registrationUrl,               // {{2}} registration URL
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: `ivr_te_${category}_link`, phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── Telugu Option 6: Book Tracking ───────────────────────────────────────────
// Same DB query as English — only template/campaign differs

export async function sendIvrTeluguBookTrackingMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const userQ = await pool.query(
    `SELECT id, name FROM users WHERE phone = $1 LIMIT 1`,
    [normalized]
  );

  if (!userQ.rows.length) {
    return sendIvrTeluguNotRegisteredMessage(normalized);
  }

  const user = userQ.rows[0];

  const shipmentsQ = await pool.query(
    `SELECT
       s.id AS shipment_id,
       s.payment_id,
       s.status,
       s.tracking_id,
       STRING_AGG(
         (COALESCE(si.book_title, '') || ' - ' || COALESCE(si.book_language, '')),
         ', ' ORDER BY si.id
       ) AS books_with_language
     FROM shipments s
     JOIN shipment_items si ON si.shipment_id = s.id
     JOIN orders o ON o.id = si.order_id
     WHERE o.user_id = $1
       AND o.payment_status = 'paid'
     GROUP BY s.id, s.payment_id, s.status, s.tracking_id
     ORDER BY s.id DESC
     LIMIT 3`,
    [user.id]
  );

  if (!shipmentsQ.rows.length) {
    // Registered but no paid shipments
    const apiKey2 = String(process.env.MNV_API_KEY || "").trim();
    const campaignName2 = String(process.env.MNV_IVR_TE_TRACKING_CAMPAIGN_NAME || "ivr_track_order_te").trim();
    const source2 = String(process.env.MNV_IVR_TE_TRACKING_SOURCE || "ivr-track-order-te").trim();
    const senderName2 = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

    if (!apiKey2 || !campaignName2) return { ok: false, reason: "provider_not_configured" };

    const noShipmentPayload = {
      apiKey: apiKey2,
      campaignName: campaignName2,
      destination: `91${normalized}`,
      userName: senderName2,
      templateParams: [
        String(user.name || "Participant").trim(),
        "మీ ఖాతాలో ఏ షిప్‌మెంట్లు కనుగొనబడలేదు.",
      ],
      source: source2,
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: { messageType: "ivr_te_no_shipments", phone: normalized },
    };

    try {
      const response = await mnvPost(noShipmentPayload);
      const responseText = typeof response === "string" ? response : JSON.stringify(response || {});
      console.log(`IVR TE NO_SHIPMENTS: phone=${normalized} responseText=${responseText}`);
      return { ok: true, providerMessageId: response?.submitted_message_id || null };
    } catch (e: any) {
      return { ok: false, reason: e?.message };
    }
  }

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TE_TRACKING_CAMPAIGN_NAME || "ivr_track_order_te").trim();
  const source = String(process.env.MNV_IVR_TE_TRACKING_SOURCE || "ivr-track-order-te").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  const summaryLines = shipmentsQ.rows.map((s: any, idx: number) => {
    const statusLabel =
      s.status === "pending"         ? "పెండింగ్"
      : s.status === "under_packing" ? "ప్యాకింగ్"
      : s.status === "packed"        ? "ప్యాక్ చేయబడింది"
      : s.status === "dispatched"    ? "పంపబడింది"
      : s.status === "delivered"     ? "డెలివరీ అయింది"
      : s.status === "returned"      ? "తిరిగి వచ్చింది"
      : s.status === "cancelled"     ? "రద్దు చేయబడింది"
      : String(s.status || "").replace(/_/g, " ");

    const books = (s.books_with_language || "Books").trim();
    const tracking = s.tracking_id ? ` TrackID:${s.tracking_id}` : "";
    return `${idx + 1}. ${books} - ${statusLabel}${tracking}`;
  });

  const hasTracking = shipmentsQ.rows.some((s: any) => s.tracking_id);
  const indiaPostLink = hasTracking ? " | Track: https://www.indiapost.gov.in" : "";
  const summary = summaryLines.join(" | ") + indiaPostLink;

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [
      String(user.name || "Participant").trim(),
      summary,
    ],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_te_book_tracking", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

async function sendIvrTeluguNotRegisteredMessage(phone: string) {
  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TE_NOT_REGISTERED_CAMPAIGN_NAME || "ivr_not_registered_te").trim();
  const source = String(process.env.MNV_IVR_TE_NOT_REGISTERED_SOURCE || "ivr-not-registered-te").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  console.log(`IVR TE NOT_REGISTERED: phone=${phone} campaign=${campaignName}`);

  if (!apiKey || !campaignName) {
    console.warn(`IVR TE NOT_REGISTERED: provider_not_configured`);
    return { ok: false, reason: "provider_not_configured" };
  }

  const payload = {
    apiKey,
    campaignName,
    destination: `91${phone}`,
    userName: senderName,
    templateParams: [],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_te_not_registered", phone },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  console.log(`IVR TE NOT_REGISTERED: phone=${phone} status=${sendStatus} responseText=${responseText}`);
  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── Telugu Option 7: Essay Help ───────────────────────────────────────────────

export async function sendIvrTeluguEssayHelpMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TE_ESSAY_HELP_CAMPAIGN_NAME || "ivr_submission_te").trim();
  const source = String(process.env.MNV_IVR_TE_ESSAY_HELP_SOURCE || "ivr-submission-te").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [String(process.env.ESSAY_VIDEO_URL || "https://www.youtube.com/shorts/tIBCql4Ed1A").trim()],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_te_essay_help", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}

// ── Telugu Option 8: Complaint ────────────────────────────────────────────────

export async function sendIvrTeluguComplaintMessage(phone: string) {
  const normalized = normPhone(phone);
  if (!normalized) return { ok: false, reason: "missing_phone" };

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_IVR_TE_COMPLAINT_CAMPAIGN_NAME || "ivr_compliant_te").trim();
  const source = String(process.env.MNV_IVR_TE_COMPLAINT_SOURCE || "ivr-complaint-te").trim();
  const senderName = String(process.env.MNV_IVR_USERNAME || "IskconContest").trim();

  if (!apiKey || !campaignName) return { ok: false, reason: "provider_not_configured" };

  const complaintFormUrl = String(process.env.COMPLAINT_FORM_URL || "https://iskconcontest.org/complaint").trim();

  const payload = {
    apiKey,
    campaignName,
    destination: `91${normalized}`,
    userName: senderName,
    templateParams: [complaintFormUrl],
    source,
    media: {},
    buttons: [],
    carouselCards: [],
    location: {},
    attributes: { messageType: "ivr_te_complaint", phone: normalized },
  };

  let sendStatus: "sent" | "failed" = "sent";
  let providerMessageId: string | null = null;
  let responseText = "";

  try {
    const response = await mnvPost(payload);
    responseText = typeof response === "string" ? response : JSON.stringify(response || {});
    providerMessageId = response?.submitted_message_id || response?.message_id || response?.id || null;
  } catch (e: any) {
    sendStatus = "failed";
    responseText = e?.message || "unknown";
  }

  return { ok: sendStatus === "sent", sendStatus, providerMessageId, responseText };
}