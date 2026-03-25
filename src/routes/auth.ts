// routes/auth.ts
import express, { Request, Response } from "express";
import { pool } from "../config/db";
import { generateToken } from "../utils/jwt";
import { hashPassword, comparePassword } from "../utils/hash";
import { body, validationResult } from "express-validator";

const router = express.Router();

const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(String(v || "").trim());
const normPhone = (v: string) => String(v || "").replace(/\D/g, "").slice(-10);
const normName = (v: string) => String(v || "").trim().replace(/\s+/g, " ");

function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production";

  res.cookie("token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function isTestModeBlocked(user: { phone?: string; role?: string }) {
  if (process.env.TEST_MODE !== "true") return false;

  const testPhone = normPhone(process.env.TEST_PHONE || "");
  const phone = normPhone(user.phone || "");
  const role = String(user.role || "").toLowerCase();

  const allowed = role === "admin" || (!!testPhone && phone === testPhone);
  return !allowed;
}

/* ---------- Register page ---------- */
router.get("/register", (_req: Request, res: Response) => {
  return res.render("register", { error: null, old: {} });
});

router.post(
  "/register",
  [
    body("name")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Please enter your full name."),
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
    body("password")
      .isLength({ min: 6, max: 100 })
      .withMessage("Password must be at least 6 characters."),
    body("confirmPassword")
      .isLength({ min: 6, max: 100 })
      .withMessage("Please confirm your password."),
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
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (password !== confirmPassword) {
      return res.status(400).json({ ok: false, message: "Passwords do not match." });
    }

    try {
      const existingPhone = await pool.query(
        `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
        [phone]
      );

      if (existingPhone.rows.length > 0) {
        return res.status(400).json({
          ok: false,
          message: "This mobile number is already registered. Please login.",
        });
      }

      const passwordHash = await hashPassword(password);

      const created = await pool.query(
        `INSERT INTO users (name, phone, phone_locked, email, password_hash)
         VALUES ($1, $2, true, NULL, $3)
         RETURNING id`,
        [name, phone, passwordHash]
      );

      const userId = created.rows[0].id;
      const token = generateToken(userId);
      setAuthCookie(res, token);

      return res.json({
        ok: true,
        redirect: "/dashboard",
      });
    } catch (e: any) {
      console.error("Register error:", e);
      return res.status(500).json({
        ok: false,
        message: "Something went wrong. Please try again.",
      });
    }
  }
);

/* ---------- Login page ---------- */
router.get("/login", (req: Request, res: Response) => {
  const token = (req as any).cookies?.token;

  if (token) {
    return res.redirect("/dashboard");
  }

  return res.render("login", { error: null, old: {} });
});

router.post(
  "/login",
  [
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number."),
    body("password")
      .isLength({ min: 1, max: 100 })
      .withMessage("Please enter your password."),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, message: errors.array()[0].msg });
    }

    const phone = normPhone(req.body.phone);
    const password = String(req.body.password || "");

    try {
      const result = await pool.query(
        `SELECT id, phone, role, password_hash
         FROM users
         WHERE phone=$1
         LIMIT 1`,
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

      if (!user.password_hash) {
        return res.status(400).json({
          ok: false,
          message: "Password login is not enabled for this account yet.",
        });
      }

      const ok = await comparePassword(password, user.password_hash);
      if (!ok) {
        return res.status(400).json({
          ok: false,
          message: "Incorrect password.",
        });
      }

        const token = generateToken(user.id);
            setAuthCookie(res, token);
            const redirectTo =
              String(user.role || "").toLowerCase() === "admin"
                ? "/admin"
                : "/dashboard";

            console.log("✅ LOGIN SUCCESS", {
              userId: user.id,
              role: user.role,
              phone,
              ua: req.headers["user-agent"],
              ip: req.ip,
              secureCookie: process.env.NODE_ENV === "production",
              redirectTo,
            });

            return res.json({
              ok: true,
              redirect: redirectTo,
            });

    } catch (e: any) {
      console.error("Login error:", e);
      return res.status(500).json({
        ok: false,
        message: "Something went wrong. Please try again.",
      });
    }
  }
);

router.get("/logout", (_req: Request, res: Response) => {
  res.clearCookie("token", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res.redirect("/login");
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("token", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res.redirect("/login");
});


export default router;