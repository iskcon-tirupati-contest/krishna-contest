import https from "https";
import { pool } from "../config/db";




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
    process.env.MNV_CAMPAIGN_CONFIRM_CAMPAIGN_NAME || "campaign_registration_success"
  ).trim();
  const source = String(
    process.env.MNV_CAMPAIGN_CONFIRM_SOURCE || "campaign-registration-success"
  ).trim();
  const senderName = String(
    process.env.MNV_CAMPAIGN_CONFIRM_USERNAME || "IskconContest"
  ).trim();

  if (!apiKey || !campaignName) {
    return { ok: false, skipped: true, reason: "provider_not_configured" as const };
  }

  const destination = `91${phone}`;

  // Suggested template params:
  // {{1}} -> participant name
  // {{2}} -> payment/order id
  // {{3}} -> contest title
  // {{4}} -> login/reset help text
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