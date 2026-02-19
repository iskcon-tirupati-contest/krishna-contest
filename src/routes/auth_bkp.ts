import express, { Request, Response } from "express";

import { pool } from "../config/db";
import { hashPassword, comparePassword } from "../utils/hash";
import { generateToken } from "../utils/jwt";
import { body, validationResult } from "express-validator";
import passport from "passport";

const router = express.Router();

// --- helpers ---
const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(String(v || "").trim());
const normEmail = (v: string) => String(v || "").trim().toLowerCase();
const normPhone = (v: string) => String(v || "").trim();

function renderAuthError(res: any, view: string, error: string, old?: any) {
  // your EJS can show: <% if (error) { %> <%= error %> <% } %>
  return res.status(400).render(view, { error, old: old || {} });
}

// -------- Register --------
router.get("/register", (_req: Request, res: Response) => {
  res.render("register", { error: null, old: {} });
});

router.post(
  "/register",
  [
    body("name")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Please enter your name (min 2 characters)."),
    body("email")
      .trim()
      .isEmail()
      .withMessage("Please enter a valid email.")
      .customSanitizer(normEmail),
    body("phone")
      .trim()
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number (starts with 6-9)."),
    body("confirmPhone")
      .trim()
      .custom((v, { req }) => normPhone(v) === normPhone(req.body.phone))
      .withMessage("Mobile numbers do not match."),
    body("password")
      .isLength({ min: 8, max: 72 })
      .withMessage("Password must be at least 8 characters.")
      .custom((v) => {
        // Basic strength: at least 1 letter and 1 number (simple + user friendly)
        if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
        return true;
      })
      .withMessage("Password must contain at least 1 letter and 1 number."),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    const old = {
      name: req.body?.name,
      email: req.body?.email,
      phone: req.body?.phone,
      confirmPhone: req.body?.confirmPhone,
    };

    if (!errors.isEmpty()) {
      return renderAuthError(res, "register", errors.array()[0].msg, old);
    }

    const name = String(req.body.name).trim();
    const email = normEmail(req.body.email);
    const phone = normPhone(req.body.phone);
    const password = String(req.body.password);

    try {
      // Check duplicates
      const existingEmail = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
      if (existingEmail.rows.length > 0) {
        return renderAuthError(res, "register", "This email is already registered. Please login.", old);
      }

      const existingPhone = await pool.query(`SELECT id FROM users WHERE phone=$1`, [phone]);
      if (existingPhone.rows.length > 0) {
        return renderAuthError(res, "register", "This mobile number is already registered. Please login.", old);
      }

      const hashed = await hashPassword(password);

      const created = await pool.query(
        `INSERT INTO users (name, email, phone, password_hash, phone_locked)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [name, email, phone, hashed]
      );

      const userId = created.rows[0].id;
      const token = generateToken(userId);

      // login immediately after registration (better UX)
      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: "/",
      });

      return res.redirect("/dashboard");
    } catch (e: any) {
      console.error("Register error:", e);
      return renderAuthError(res, "register", "Something went wrong. Please try again.", old);
    }
  }
);

// -------- Login --------
router.get("/login", (req: Request, res: Response) => {
  res.render("login", { error: null, old: {} });
});

router.post(
  "/login",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("Please enter a valid email.")
      .customSanitizer(normEmail),
    body("password").isLength({ min: 1 }).withMessage("Password is required."),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    const old = { email: req.body?.email };

    if (!errors.isEmpty()) {
      return renderAuthError(res, "login", errors.array()[0].msg, old);
    }

    const email = normEmail(req.body.email);
    const password = String(req.body.password);

    try {
      const result = await pool.query(
        `SELECT id, password_hash FROM users WHERE email=$1`,
        [email]
      );

      if (result.rows.length === 0) {
        // Do not reveal whether user exists (security)
        return renderAuthError(res, "login", "Invalid email or password.", old);
      }

      const user = result.rows[0];
      const isMatch = await comparePassword(password, user.password_hash);
      if (!isMatch) {
        return renderAuthError(res, "login", "Invalid email or password.", old);
      }

      const token = generateToken(user.id);

      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 7 * 24 * 60 * 60 * 1000,
          path: "/",

      });

      return res.redirect("/dashboard");
    } catch (e: any) {
      console.error("Login error:", e);
      return renderAuthError(res, "login", "Something went wrong. Please try again.", old);
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



// Google Login start
router.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
    prompt: "select_account",
  })
);

router.get(
  "/auth/google/switch",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
    prompt: "select_account",
  })
);



// Google callback
router.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: "/login?error=google",
  }),
  async (req: any, res: any) => {
    const userId = req.user?.id;
    if (!userId) return res.redirect("/login?error=google");

    const token = generateToken(userId);

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
       path: "/",
    });

    // OPTIONAL but recommended: if phone missing, show a friendly message on dashboard
    // (or later create /complete-profile to collect phone)
    return res.redirect("/dashboard");
  }
);


export default router;
