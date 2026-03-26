import axios from "axios";
import crypto from "crypto";
import { pool } from "../config/db";

type OtpPurpose = "register" | "forgot_password";

type SendOtpInput = {
  phone: string;
  name?: string;
  purpose: OtpPurpose;
};

type VerifyOtpInput = {
  phone: string;
  purpose: OtpPurpose;
  otp: string;
};

type OtpDeliveryResult = {
  provider: string;
  responseText: string;
};
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);
const OTP_VERIFY_TOKEN_TTL_MINUTES = Number(process.env.OTP_VERIFY_TOKEN_TTL_MINUTES || 15);

const OTP_PROVIDER = String(process.env.OTP_PROVIDER || "mnv_whatsapp").trim().toLowerCase();

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normPhone(v: string) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

async function sendViaMnvWhatsApp(params: {
  phone: string;
  name?: string;
  otp: string;
  purpose: OtpPurpose;
}): Promise<OtpDeliveryResult> {
  const apiUrl =
    process.env.MNV_API_URL || "https://backend.api-wa.co/campaign/mnv-solutions/api/v2";

  const apiKey = String(process.env.MNV_API_KEY || "").trim();
  const campaignName = String(process.env.MNV_CAMPAIGN_NAME || "OTP").trim();

  // Keep this same as the working portal test
  const userName = String(process.env.MNV_USERNAME || "IskconContest").trim();

  // Keep this same as the working portal test
  const source = String(process.env.MNV_SOURCE || "new-landing-page form").trim();

  if (!apiKey) {
    throw new Error("OTP provider is not configured.");
  }

  const phone10 = normPhone(params.phone);
  const destination = `91${phone10}`;

  const otpValue = String(params.otp);

  const payload = {
    apiKey,
    campaignName,
    destination,
    userName,

    // Send actual OTP value here
    templateParams: [otpValue],

    source,
    media: {},

    // IMPORTANT: portal test includes a URL button variable
    buttons: [
      {
        type: "button",
        sub_type: "url",
        index: 0,
        parameters: [
          {
            type: "text",
            text: otpValue,
          },
        ],
      },
    ],

    carouselCards: [],
    location: {},
    attributes: {},

    // Keep fallback too
    paramsFallbackValue: {
      FirstName: otpValue,
    },
  };

  console.log("MNV payload:", JSON.stringify(payload));

  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    console.log("MNV response:", response.data);

    return {
      provider: "mnv_whatsapp",
      responseText:
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data || {}),
    };
  } catch (err: any) {
    console.error("MNV ERROR RESPONSE:", err?.response?.data);
    console.error("MNV ERROR MESSAGE:", err?.message);
    throw new Error(
      err?.response?.data?.message || "Failed to send OTP"
    );
  }
}


async function sendViaSmsStub(_params: {
  phone: string;
  name?: string;
  otp: string;
  purpose: OtpPurpose;
}): Promise<OtpDeliveryResult> {
  throw new Error("SMS OTP provider is not configured yet.");
}

async function sendWithActiveProvider(params: {
  phone: string;
  name?: string;
  otp: string;
  purpose: OtpPurpose;
}): Promise<OtpDeliveryResult> {
  switch (OTP_PROVIDER) {
    case "mnv_whatsapp":
      return await sendViaMnvWhatsApp(params);
    case "sms_dlt":
      return await sendViaSmsStub(params);
    default:
      throw new Error("Invalid OTP provider configuration.");
  }
}

export function getOtpChannelLabel() {
  switch (OTP_PROVIDER) {
    case "mnv_whatsapp":
      return "WhatsApp";
    case "sms_dlt":
      return "SMS";
    default:
      return "OTP";
  }
}

export async function sendOtp(input: SendOtpInput) {
  const phone = normPhone(input.phone);
  const purpose = input.purpose;

  const latest = await pool.query(
    `
    SELECT id, created_at
    FROM user_otps
    WHERE phone = $1 AND purpose = $2
    ORDER BY id DESC
    LIMIT 1
    `,
    [phone, purpose]
  );

  if (latest.rows.length > 0) {
    const lastCreatedAt = new Date(latest.rows[0].created_at).getTime();
    const diffSeconds = Math.floor((Date.now() - lastCreatedAt) / 1000);
    const waitSeconds = OTP_RESEND_COOLDOWN_SECONDS - diffSeconds;

    if (waitSeconds > 0) {
      const err: any = new Error(`Please wait ${waitSeconds}s before requesting another OTP.`);
      err.code = "OTP_COOLDOWN";
      err.retryAfter = waitSeconds;
      throw err;
    }
  }

  const otp = randomOtp();
  const otpHash = sha256(otp);

  const delivery = await sendWithActiveProvider({
    phone,
    name: input.name,
    otp,
    purpose,
  });

  await pool.query(
    `
    UPDATE user_otps
    SET is_used = TRUE,
        updated_at = CURRENT_TIMESTAMP
    WHERE phone = $1
      AND purpose = $2
      AND is_used = FALSE
    `,
    [phone, purpose]
  );

  await pool.query(
    `
    INSERT INTO user_otps
      (phone, purpose, otp_hash, provider, expires_at, attempts_left, is_used, provider_response)
    VALUES
      ($1, $2, $3, $4, CURRENT_TIMESTAMP + ($5 || ' minutes')::interval, $6, FALSE, $7)
    `,
    [
      phone,
      purpose,
      otpHash,
      delivery.provider,
      String(OTP_EXPIRY_MINUTES),
      OTP_MAX_ATTEMPTS,
      delivery.responseText,
    ]
  );

  return {
    ok: true,
    channel: getOtpChannelLabel(),
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export async function verifyOtp(input: VerifyOtpInput) {
  const phone = normPhone(input.phone);
  const purpose = input.purpose;
  const otp = String(input.otp || "").trim();

  const q = await pool.query(
    `
    SELECT *
    FROM user_otps
    WHERE phone = $1
      AND purpose = $2
      AND is_used = FALSE
    ORDER BY id DESC
    LIMIT 1
    `,
    [phone, purpose]
  );

  if (q.rows.length === 0) {
    throw new Error("OTP not found. Please request a new OTP.");
  }

  const row = q.rows[0];

  if (row.attempts_left <= 0) {
    throw new Error("Too many incorrect OTP attempts. Please request a new OTP.");
  }

  const validOtpRow = await pool.query(
    `
    SELECT id
    FROM user_otps
    WHERE id = $1
      AND expires_at >= CURRENT_TIMESTAMP
    LIMIT 1
    `,
    [row.id]
  );

  if (validOtpRow.rows.length === 0) {
    await pool.query(
      `
      UPDATE user_otps
      SET is_used = TRUE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.id]
    );
    throw new Error("OTP has expired. Please request a new OTP.");
  }

  const incomingHash = sha256(otp);

  if (incomingHash !== row.otp_hash) {
    await pool.query(
      `
      UPDATE user_otps
      SET attempts_left = GREATEST(attempts_left - 1, 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.id]
    );
    throw new Error("Invalid OTP.");
  }

  let verifyToken: string | null = null;
  let verifyTokenHash: string | null = null;

  if (purpose === "forgot_password") {
    verifyToken = randomToken();
    verifyTokenHash = sha256(verifyToken);
  }

  await pool.query(
    `
    UPDATE user_otps
    SET is_used = TRUE,
        verified_at = CURRENT_TIMESTAMP,
        verify_token_hash = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [row.id, verifyTokenHash]
  );

  return {
    ok: true,
    token: verifyToken,
  };
}


export async function consumeForgotPasswordToken(phoneInput: string, token: string) {
  const phone = normPhone(phoneInput);
  const tokenHash = sha256(String(token || "").trim());

  const q = await pool.query(
    `
    SELECT id, verified_at
    FROM user_otps
    WHERE phone = $1
      AND purpose = 'forgot_password'
      AND verify_token_hash = $2
      AND verified_at IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
    `,
    [phone, tokenHash]
  );

  if (q.rows.length === 0) {
    throw new Error("Password reset session is invalid. Please verify OTP again.");
  }

  const row = q.rows[0];

const stillValid = await pool.query(
  `
  SELECT id
  FROM user_otps
  WHERE id = $1
    AND verified_at IS NOT NULL
    AND verified_at >= CURRENT_TIMESTAMP - ($2 || ' minutes')::interval
  LIMIT 1
  `,
  [row.id, String(OTP_VERIFY_TOKEN_TTL_MINUTES)]
);

if (stillValid.rows.length === 0) {
  await pool.query(
    `
    UPDATE user_otps
    SET verify_token_hash = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [row.id]
  );
  throw new Error("Password reset session has expired. Please verify OTP again.");
}



  return { ok: true };
}