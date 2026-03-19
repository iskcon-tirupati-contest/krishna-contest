// routes/auth.ts
import express, { Request, Response } from "express";
import { pool } from "../config/db";
import { generateToken } from "../utils/jwt";
import { body, validationResult } from "express-validator";
import https from "https";

const router = express.Router();

const WA_AUTHKEY = process.env.WA_AUTHKEY || "";
const WA_OTP_WID = process.env.WA_OTP_WID || "";

const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(String(v || "").trim());
const normPhone = (v: string) => String(v || "").replace(/\D/g, "").slice(-10);
const normName = (v: string) => String(v || "").trim().replace(/\s+/g, " ");

function renderAuthError(res: Response, view: string, error: string, old?: any) {
  return res.status(400).render(view, { error, old: old || {} });
}

function setAuthCookie(res: Response, token: string) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

async function redirectByRole(res: Response, userId: string) {
  const r = await pool.query(`SELECT role FROM users WHERE id=$1`, [userId]);
  const role = (r.rows[0]?.role || "user").toLowerCase();

  if (role === "admin") return res.redirect("/admin");
  return res.redirect("/dashboard");
}

function isTestModeBlocked(user: { phone?: string; role?: string }) {
  if (process.env.TEST_MODE !== "true") return false;

  const testPhone = normPhone(process.env.TEST_PHONE || "");
  const phone = normPhone(user.phone || "");
  const role = String(user.role || "").toLowerCase();

  const allowed = role === "admin" || (!!testPhone && phone === testPhone);
  return !allowed;
}

function renderTestingMode(res: Response, message: string) {
  return res.status(403).render("testing-mode", { message });
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function deleteExpiredOtps() {
  await pool.query(`DELETE FROM auth_otps WHERE expires_at < CURRENT_TIMESTAMP`);
}

async function storeOtp(phone: string, purpose: "register" | "login", otp: string) {
  await deleteExpiredOtps();

  await pool.query(
    `DELETE FROM auth_otps WHERE phone=$1 AND purpose=$2`,
    [phone, purpose]
  );

  await pool.query(
    `INSERT INTO auth_otps (phone, otp_code, purpose, expires_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
    [phone, otp, purpose]
  );
}

async function verifyOtp(phone: string, purpose: "register" | "login", otp: string) {
  await deleteExpiredOtps();

  const q = await pool.query(
    `SELECT id
     FROM auth_otps
     WHERE phone=$1
       AND purpose=$2
       AND otp_code=$3
       AND verified=false
       AND expires_at >= CURRENT_TIMESTAMP
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone, purpose, otp]
  );

  if (q.rows.length === 0) return false;

  await pool.query(`UPDATE auth_otps SET verified=true WHERE id=$1`, [q.rows[0].id]);
  return true;
}

function sendOmnlyJson(payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: "panel.omnly.in",
        path: "/restapi/requestjson.php",
        method: "POST",
        headers: {
          Authorization: `Basic ${WA_AUTHKEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const json = body ? JSON.parse(body) : {};
            if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
              return resolve(json);
            }
            return reject(new Error(body || `WA OTP failed with status ${res.statusCode}`));
          } catch {
            if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
              return resolve(body);
            }
            return reject(new Error(body || `WA OTP failed with status ${res.statusCode}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendWhatsappOtp(phone: string, otp: string) {
  if (!WA_AUTHKEY || !WA_OTP_WID) {
    throw new Error("Missing WA_AUTHKEY or WA_OTP_WID in .env");
  }

  const payload = {
    country_code: "91",
    wid: WA_OTP_WID,
    type: "text",
    data: [
      {
        mobile: phone,
        bodyValues: {
          "1": otp,
        },
      },
    ],
  };

  return sendOmnlyJson(payload);
}

// -------- Register page --------
router.get("/register", (_req: Request, res: Response) => {
  if (process.env.TEST_MODE === "true") {
    return renderTestingMode(
      res,
      "🚧 Website is currently under testing. New registrations are temporarily disabled."
    );
  }
  return res.render("register", { error: null, old: {} });
});

// Step 1: send OTP for register
router.post(
  "/register/send-otp",
  [
    body("name")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Please enter your full name."),
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
  ],
  async (req: Request, res: Response) => {
    if (process.env.TEST_MODE === "true") {
      return res.status(403).json({
        ok: false,
        message: "Website is currently under testing. New registrations are temporarily disabled.",
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: errors.array()[0].msg });
    }

    const name = normName(req.body.name);
    const phone = normPhone(req.body.phone);

    try {
      const existingPhone = await pool.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [phone]);
      if (existingPhone.rows.length > 0) {
        return res.status(400).json({
          ok: false,
          message: "This mobile number is already registered. Please login.",
        });
      }

      const otp = generateOtp();
      await storeOtp(phone, "register", otp);
      await sendWhatsappOtp(phone, otp);

      return res.json({
        ok: true,
        message: `OTP sent to WhatsApp number ${phone}`,
        phone,
        name,
      });
    } catch (e: any) {
      console.error("Register send OTP error:", e);
      return res.status(500).json({
        ok: false,
        message: "Unable to send OTP right now. Please try again.",
      });
    }
  }
);

// Step 2: verify OTP and create user
router.post(
  "/register/verify-otp",
  [
    body("name")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Please enter your full name."),
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
    body("otp")
      .trim()
      .isLength({ min: 4, max: 10 })
      .withMessage("Please enter a valid OTP."),
  ],
  async (req: Request, res: Response) => {
    if (process.env.TEST_MODE === "true") {
      return res.status(403).json({
        ok: false,
        message: "Website is currently under testing. New registrations are temporarily disabled.",
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: errors.array()[0].msg });
    }

    const name = normName(req.body.name);
    const phone = normPhone(req.body.phone);
    const otp = String(req.body.otp || "").trim();

    try {
      const existingPhone = await pool.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [phone]);
      if (existingPhone.rows.length > 0) {
        return res.status(400).json({
          ok: false,
          message: "This mobile number is already registered. Please login.",
        });
      }

      const ok = await verifyOtp(phone, "register", otp);
      if (!ok) {
        return res.status(400).json({ ok: false, message: "Invalid or expired OTP." });
      }

      const created = await pool.query(
        `INSERT INTO users (name, phone, phone_locked, email, password_hash)
         VALUES ($1, $2, true, NULL, NULL)
         RETURNING id`,
        [name, phone]
      );

      const userId = created.rows[0].id;
      const token = generateToken(userId);
      setAuthCookie(res, token);

      return res.json({
        ok: true,
        redirect: "/dashboard",
      });
    } catch (e: any) {
      console.error("Register verify OTP error:", e);
      return res.status(500).json({
        ok: false,
        message: "Something went wrong. Please try again.",
      });
    }
  }
);

// -------- Login page --------
router.get("/login", (_req: Request, res: Response) => {
  return res.render("login", { error: null, old: {} });
});

// Step 1: send OTP for login
router.post(
  "/login/send-otp",
  [
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: errors.array()[0].msg });
    }

    const phone = normPhone(req.body.phone);

    try {
      const result = await pool.query(
        `SELECT id, phone, role FROM users WHERE phone=$1 LIMIT 1`,
        [phone]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "This mobile number is not registered. Please register first.",
        });
      }

      const user = result.rows[0];
      if (isTestModeBlocked(user)) {
        return res.status(403).json({
          ok: false,
          message: "Website is under testing. Only admin and approved test users can login.",
        });
      }

      const otp = generateOtp();
      await storeOtp(phone, "login", otp);
      await sendWhatsappOtp(phone, otp);

      return res.json({
        ok: true,
        message: `OTP sent to WhatsApp number ${phone}`,
      });
    } catch (e: any) {
      console.error("Login send OTP error:", e);
      return res.status(500).json({
        ok: false,
        message: "Unable to send OTP right now. Please try again.",
      });
    }
  }
);

// Step 2: verify OTP and login
router.post(
  "/login/verify-otp",
  [
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
    body("otp")
      .trim()
      .isLength({ min: 4, max: 10 })
      .withMessage("Please enter a valid OTP."),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: errors.array()[0].msg });
    }

    const phone = normPhone(req.body.phone);
    const otp = String(req.body.otp || "").trim();

    try {
      const result = await pool.query(
        `SELECT id, phone, role FROM users WHERE phone=$1 LIMIT 1`,
        [phone]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "This mobile number is not registered. Please register first.",
        });
      }

      const user = result.rows[0];
      if (isTestModeBlocked(user)) {
        return res.status(403).json({
          ok: false,
          message: "Website is under testing. Only admin and approved test users can login.",
        });
      }

      const ok = await verifyOtp(phone, "login", otp);
      if (!ok) {
        return res.status(400).json({ ok: false, message: "Invalid or expired OTP." });
      }

      const token = generateToken(user.id);
      setAuthCookie(res, token);

      const roleQ = await pool.query(`SELECT role FROM users WHERE id=$1`, [user.id]);
      const role = (roleQ.rows[0]?.role || "user").toLowerCase();

      return res.json({
        ok: true,
        redirect: role === "admin" ? "/admin" : "/dashboard",
      });
    } catch (e: any) {
      console.error("Login verify OTP error:", e);
      return res.status(500).json({
        ok: false,
        message: "Something went wrong. Please try again.",
      });
    }
  }
);

// -------- Logout --------
router.get("/logout", (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res.redirect("/login");
});

export default router;