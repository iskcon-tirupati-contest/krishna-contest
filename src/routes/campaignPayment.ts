import express from "express";
import crypto from "crypto";
import https from "https";
import { pool } from "../config/db";
import { sendCampaignRegistrationMessageOnce } from "../services/contestConfirmation";
const router = express.Router();

const RZP_KEY_ID = process.env.RZP_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RZP_KEY_SECRET || "";
const RZP_CAMPAIGN_WEBHOOK_SECRET = process.env.RZP_CAMPAIGN_WEBHOOK_SECRET || "";

// Fixed Ramayana campaign config
const CAMPAIGN_SOURCE = "ramayana_campaign_2026";
const RAMAYANA_CONTEST_ID = "5c4c57df-5913-4abe-a0f0-9c42114bc3c0";
//const EXPECTED_AMOUNT_PAISE = 39900;
//const EXPECTED_AMOUNT_RUPEES = 399;

const EXPECTED_AMOUNT_PAISE = 39900;
const EXPECTED_AMOUNT_RUPEES = 399;

const FIXED_BOOK_TITLE = "Ramayana";

type RazorpayPayment = {
  id: string;
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  email?: string;
  contact?: string;
  notes?: Record<string, any>;
};

function assertRzpEnv() {
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    throw new Error("Missing Razorpay API keys. Set RZP_KEY_ID and RZP_KEY_SECRET.");
  }
  if (!RZP_CAMPAIGN_WEBHOOK_SECRET) {
    throw new Error("Missing RZP_CAMPAIGN_WEBHOOK_SECRET.");
  }
}

function rzpRequest<T>(method: "GET" | "POST", path: string, body?: any): Promise<T> {
  assertRzpEnv();

  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
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

          if (statusCode >= 200 && statusCode < 300) {
            return resolve(json as T);
          }

          const msg =
            json?.error?.description ||
            json?.error?.message ||
            `Razorpay API error (${statusCode})`;

          return reject(new Error(msg));
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!RZP_CAMPAIGN_WEBHOOK_SECRET) return false;

  const expected = crypto
    .createHmac("sha256", RZP_CAMPAIGN_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const got = String(signature || "");

  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

function genInternalPaymentId(): string {
  return "KNC" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

function norm(v: any): string {
  return String(v ?? "").trim();
}

function normPhone(v: any): string {
  return String(v ?? "").replace(/\D/g, "").slice(-10);
}

function normEmail(v: any): string {
  return String(v ?? "").trim().toLowerCase();
}

function isValidIndianMobile(v: string): boolean {
  return /^[6-9]\d{9}$/.test(v);
}

function isValidPincode(v: string): boolean {
  return /^[1-9]\d{5}$/.test(v);
}

function normalizeAgeCategory(v: string): "0-25" | "above-25" | null {
  const x = norm(v).toLowerCase();

  if (!x) return null;

  if (
    x === "above 25" ||
    x === "above-25" ||
    x === "above_25" ||
    x === "above25" ||
    x === "25+" ||
    x === "above 25 years" ||
    x === "above 25 yrs"
  ) {
    return "above-25";
  }

  if (
    x === "0-25" ||
    x === "0 to 25" ||
    x === "0-25 years" ||
    x === "0 to 25 years" ||
    x === "below 25" ||
    x === "below 25 years" ||
    x === "0to25"
  ) {
    return "0-25";
  }

  return null;
}

function normalizeDeliveryMode(v: string): "home_delivery" | "temple_pickup" | "donation" | null {
  const x = norm(v).toLowerCase();

  if (
    x === "home_delivery" ||
    x === "home delivery"
  ) return "home_delivery";

  if (
    x === "temple_pickup" ||
    x === "temple pickup" ||
    x === "collect directly from temple"
  ) return "temple_pickup";

  if (
    x === "donation" ||
    x === "donate book" ||
    x === "donate books"
  ) return "donation";

  return null;
}


function safeJsonParse(raw: Buffer): any {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function pickNote(notes: Record<string, any> | undefined, key: string): string {
  if (!notes) return "";
  return norm(notes[key]);
}

async function findContest(): Promise<{ id: string; price: number; default_book_title: string }> {
  const q = await pool.query(
    `SELECT id, price, default_book_title
     FROM contests
     WHERE id=$1
       AND is_active=true
     LIMIT 1`,
    [RAMAYANA_CONTEST_ID]
  );

  if (q.rows.length === 0) {
    throw new Error("Ramayana contest is missing or inactive.");
  }

  return {
    id: String(q.rows[0].id),
    price: Number(q.rows[0].price || 0),
    default_book_title: String(q.rows[0].default_book_title || FIXED_BOOK_TITLE).trim() || FIXED_BOOK_TITLE,
  };
}

async function findUserByPhone(phone: string): Promise<any | null> {
  const q = await pool.query(
    `SELECT id, name, email, phone, address, city, state, pincode
     FROM users
     WHERE phone=$1
     LIMIT 1`,
    [phone]
  );
  return q.rows[0] || null;
}

async function createUser(params: {
  name: string;
  phone: string;
  email: string | null;
}): Promise<any> {
  const q = await pool.query(
    `INSERT INTO users (name, phone, phone_locked, email)
     VALUES ($1, $2, true, $3)
     RETURNING id, name, email, phone, address, city, state, pincode`,
    [params.name, params.phone, params.email]
  );

  return q.rows[0];
}

router.post("/payment/campaign/ramayana/webhook", async (req: any, res) => {
  try {
/*
  console.log("Campaign webhook hit========", {
  method: req.method,
  contentType: req.headers["content-type"],
  hasSig: !!req.headers["x-razorpay-signature"],
  isBuffer: Buffer.isBuffer(req.body),
  bodyType: typeof req.body,
});
*/
    const rawBody: Buffer = req.body;
    const sig = String(req.headers["x-razorpay-signature"] || "");

    if (!Buffer.isBuffer(rawBody)) {
     //  console.log("========Expected raw body issue");
      return res.status(400).send("Expected raw body");
    }

    if (!sig) {
     // console.log("===========Missing x-razorpay-signature");
      return res.status(400).send("Missing x-razorpay-signature");
    }

    if (!verifyWebhookSignature(rawBody, sig)) {
   //   console.log("===========Invalid webhook signature");
      return res.status(400).send("Invalid webhook signature");
    }

    const event = safeJsonParse(rawBody);
    if (!event) {
    //  console.log("Invalid JSON");
      return res.status(400).send("Invalid JSON");
    }

    const eventType = norm(event?.event);
    const eventId = norm(event?.contains?.[0]) || norm(event?.account_id) || norm(event?.id);
    const paymentEntity = event?.payload?.payment?.entity || {};

    const webhookPaymentId = norm(paymentEntity?.id);
    const webhookOrderId = norm(paymentEntity?.order_id);
    const webhookStatus = norm(paymentEntity?.status);


     //console.log("REACJED 00=================================");

    if (eventType !== "payment.captured") {

    //   console.log("=========Payment not captured hence returning....");
      return res.status(200).json({ ok: true, ignored: true, reason: "not_payment_captured" });
    }

    if (!webhookPaymentId) {
	// console.log("=======Payment id webhook empty hence returning....");
      return res.status(200).json({ ok: true, ignored: true, reason: "missing_payment_id" });
    }

    // console.log("REACJED 001=================================");
    // Dual verification from Razorpay API
    const pay = await rzpRequest<RazorpayPayment>(
      "GET",
      `/v1/payments/${encodeURIComponent(webhookPaymentId)}`
    );

    const verifiedPaymentId = norm(pay.id);
    const verifiedOrderId = norm(pay.order_id);
    const verifiedStatus = norm(pay.status);
    const verifiedAmount = Number(pay.amount || 0);
    const verifiedCurrency = norm(pay.currency || "INR");
    const notes = (pay.notes || {}) as Record<string, any>;


    if (!verifiedPaymentId || verifiedPaymentId !== webhookPaymentId) {
    //  console.log("========Payment verification mismatch:", verifiedPaymentId);
     // console.log("========webhookPaymentId  mismatch:", webhookPaymentId);
      return res.status(400).send("Payment verification mismatch");
    }

    if (verifiedStatus !== "captured") {
   //   console.log("CAPTURE STATUS NOT MATCHING ",verifiedStatus);
      return res.status(200).json({ ok: true, ignored: true, reason: "payment_not_captured" });
    }


    if (verifiedAmount !== EXPECTED_AMOUNT_PAISE) {
    //  console.log("==========verifiedAmount NOT MATCHING ",verifiedAmount);
      return res.status(400).send("Unexpected payment amount");
    }

    const payerName = pickNote(notes, "payer_name") || pickNote(notes, "payer__name");
    const mobileNoRaw = pickNote(notes, "mobile_no") || norm(pay.contact);
    const address = pickNote(notes, "address");
    const city = pickNote(notes, "city");
    const state = pickNote(notes, "state");

    const pincode = pickNote(notes, "pincode") || pickNote(notes, "pin_code");
    const bookLanguage = pickNote(notes, "book_language");
    const ageRaw = pickNote(notes, "age");
    const deliveryModeRaw = pickNote(notes, "delivery_mode");
    const emailRaw = norm(pay.email);

    const phone = normPhone(mobileNoRaw);
    const fullName = payerName || "Participant";
    const ageCategory = normalizeAgeCategory(ageRaw);
    const deliveryMode = normalizeDeliveryMode(deliveryModeRaw);
    const email = emailRaw ? normEmail(emailRaw) : null;

    console.log("USER DETAILS============");
    console.log("Name:",fullName);
    console.log("Payer Name:",payerName);
    console.log("phone:",phone);
    /*console.log("age:",fullName);
    console.log("delivery:",fullName);
    console.log("addres:",fullName);
    console.log("city:",fullName);
    console.log("state:",fullName);
    console.log("pin code:",fullName);
*/
    const contest = await findContest();
    const internalPaymentId = genInternalPaymentId();
   //  console.log("REACJED 1=================================");
    await pool.query("BEGIN");
    try {
      // First duplicate guard
      const eventInsert = await pool.query(
        `INSERT INTO campaign_payment_events
         (source, razorpay_event_id, razorpay_payment_id, razorpay_order_id, internal_payment_id, status, meta)
         VALUES ($1,$2,$3,$4,$5,'processing',$6::jsonb)
         ON CONFLICT (source, razorpay_payment_id) DO NOTHING
         RETURNING id`,
        [
          CAMPAIGN_SOURCE,
          eventId || null,
          verifiedPaymentId,
          verifiedOrderId || null,
          internalPaymentId,
          JSON.stringify({
            eventType,
            webhookOrderId,
            webhookStatus,
            verifiedOrderId,
            verifiedStatus,
            verifiedAmount,
            notes,
          }),
        ]
      );
      if (eventInsert.rows.length === 0) {
      //  console.log("===========EVENT INSERT ROWS ==0 HECE RETURNIONG....");
        await pool.query("ROLLBACK");
        return res.status(200).json({ ok: true, duplicate: true });
      }
     //  console.log("REACJED 2 =================================");
      let user = await findUserByPhone(phone);

      if (!user) {
        // email unique safety: if email already belongs to another user, store null instead
        let emailToSave: string | null = email;

        if (emailToSave) {
          const emailClash = await pool.query(
            `SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
            [emailToSave]
          );
          if (emailClash.rows.length > 0) {
            emailToSave = null;
          }
        }

        user = await createUser({
          name: fullName,
          phone,
          email: emailToSave,
        });
      } else {
        // Optional light-touch update for existing user
        if ((!user.name || String(user.name).trim() === "") && fullName) {
          await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [fullName, user.id]);
          user.name = fullName;
        }

        if (deliveryMode === "home_delivery") {
          await pool.query(
            `UPDATE users
             SET address=$1, city=$2, state=$3, pincode=$4
             WHERE id=$5`,
            [address, city, state, pincode, user.id]
          );
        }
      }
     //console.log("REACJED 3=================================");
      const paymentSessionQ = await pool.query(
        `INSERT INTO payment_sessions (user_id, payment_id, amount, status)
         VALUES ($1,$2,$3,'paid')
         RETURNING id`,
        [user.id, verifiedOrderId || verifiedPaymentId, EXPECTED_AMOUNT_RUPEES]
      );

      const paymentSessionId = paymentSessionQ.rows[0].id;

      const orderQ = await pool.query(
        `INSERT INTO orders
         (user_id, contest_id, amount, payment_status, payment_id, age_category, created_at, book_option, full_name, book_title, payment_session_id)
         VALUES ($1,$2,$3,'paid',$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata'),$6,$7,$8,$9)
         RETURNING id`,
        [
          user.id,
          contest.id,
          contest.price,
          internalPaymentId,
          ageCategory,
          "book",
          fullName,
          contest.default_book_title,
          paymentSessionId,
        ]
      );
      const orderId = orderQ.rows[0].id;
     //  console.log("REACJED 4================================");
       const shipmentQ =
  deliveryMode === "temple_pickup"
    ? await pool.query(
        `INSERT INTO shipments
         (payment_id, recipient_name, recipient_phone, delivery_mode, status, updated_at)
         VALUES ($1,$2,$3,'temple_pickup','pending',NOW())
         RETURNING id`,
        [internalPaymentId, fullName, phone]
      )
    : deliveryMode === "donation"
    ? await pool.query(
        `INSERT INTO shipments
         (payment_id, delivery_mode, status, updated_at)
         VALUES ($1,'donation','pending',NOW())
         RETURNING id`,
        [internalPaymentId]
      )
    : await pool.query(
        `INSERT INTO shipments
         (payment_id, recipient_name, recipient_phone, address, city, state, pincode, delivery_mode, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'home_delivery','pending',NOW())
         RETURNING id`,
        [internalPaymentId, fullName, phone, address, city, state, pincode]
      );
      const shipmentId = shipmentQ.rows[0].id;
      // console.log("REACJED 5=================================");
      await pool.query(
        `INSERT INTO shipment_items (shipment_id, order_id, book_title, book_language)
         VALUES ($1,$2,$3,$4)`,
        [shipmentId, orderId, contest.default_book_title || FIXED_BOOK_TITLE, bookLanguage]
      );

      await pool.query(
        `UPDATE campaign_payment_events
         SET status='processed', processed_at=(NOW() AT TIME ZONE 'Asia/Kolkata')
         WHERE source=$1 AND razorpay_payment_id=$2`,
        [CAMPAIGN_SOURCE, verifiedPaymentId]
      );

      await pool.query("COMMIT");
      console.log("Ramayana contest successfully registered");
      console.log("Full name: ", fullName);
      console.log("Phone:",  phone);
      console.log("shipment id:", shipmentId);
      console.log("order id id:", orderId);

    try {
      await sendCampaignRegistrationMessageOnce({
        paymentId: internalPaymentId,
        paymentSessionId,
        userId: String(user.id),
        phone: String(phone || ""),
        userName: String(fullName || "Participant"),
        contestTitle: "Ramayana Essay Writing Contest",
        loginHelpText: "Login with your mobile number, reset password in profile, then submit your essay.",
      });
    } catch (e) {
      console.error("campaign registration confirmation send error:", e);
    }


      return res.status(200).json({
        ok: true,
        processed: true,
        internalPaymentId,
        orderId,
        shipmentId,
        paymentSessionId,
      });
    } catch (dbErr) {
      console.log("===========DATABASE ERROR, HECE RETURNIONG....");
      await pool.query("ROLLBACK");
      throw dbErr;
    }
  } catch (e) {
    console.error("Ramayana campaign webhook error:", e);
    return res.status(500).send("Webhook error");
  }
});

export default router;
