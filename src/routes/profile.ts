// src/routes/profile.ts
import express, { Response } from "express";
import { body, validationResult } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";
import { hashPassword } from "../utils/hash";

const router = express.Router();

const norm = (v: any) => String(v ?? "").trim();
const isValidPincode = (v: string) => /^[1-9]\d{5}$/.test(norm(v));
const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm(v).toLowerCase());

function renderProfile(res: Response, data: any) {
  return res.render("dashboard-profile", data);
}



async function getGroupedPayments(userId: string) {
  const q = await pool.query(
    `SELECT
        o.payment_id AS internal_payment_id,
        MIN(o.created_at) AS created_at,
        COALESCE(SUM(o.amount), 0)::int AS total_amount,
        STRING_AGG(c.title, ' • ' ORDER BY c.title) AS contest_titles,
        COUNT(*)::int AS item_count,
        COALESCE(MAX(ps.status), MAX(o.payment_status), 'pending') AS status
     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     LEFT JOIN payment_sessions ps ON ps.id = o.payment_session_id
     WHERE o.user_id=$1
       AND o.payment_id IS NOT NULL
     GROUP BY o.payment_id
     ORDER BY MIN(o.created_at) DESC`,
    [userId]
  );
  return q.rows;
}

async function getUserById(userId: string) {
  const u = await pool.query(
    `SELECT id, name, email, phone, phone_locked, role, address, city, state, pincode
     FROM users
     WHERE id=$1
     LIMIT 1`,
    [userId]
  );
  return u.rows[0] || null;
}

// GET profile
router.get("/dashboard/profile", authMiddleware, async (req: any, res: Response) => {
  const userId = req.userId;
  const tab = String(req.query.tab || "profile").trim();

  const user = await getUserById(userId);
  if (!user) return res.status(404).send("User not found");

  const payments = await getGroupedPayments(userId);

  return renderProfile(res, {
    activeTab: "profile",
    profileTab: tab === "payments" ? "payments" : "profile",
    user,
    addr: {
      address: user.address || "",
      city: user.city || "",
      state: user.state || "",
      pincode: user.pincode || "",
    },
    payments,
    error: null,
    success: null,
    old: {},
  });
});

// POST profile update
router.post(
  "/dashboard/profile",
  authMiddleware,
  [
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Please enter your email address.")
      .bail()
      .custom((v) => isValidEmail(v))
      .withMessage("Please enter a valid email address."),
    body("address")
      .trim()
      .notEmpty()
      .withMessage("Please enter your address.")
      .bail()
      .isLength({ min: 5, max: 500 })
      .withMessage("Address must be between 5 and 500 characters."),
    body("city")
      .trim()
      .notEmpty()
      .withMessage("Please enter your city.")
      .bail()
      .isLength({ min: 2, max: 100 })
      .withMessage("City must be between 2 and 100 characters."),
    body("state")
      .trim()
      .notEmpty()
      .withMessage("Please select your state.")
      .bail()
      .isLength({ max: 100 })
      .withMessage("State is invalid."),
    body("pincode")
      .trim()
      .notEmpty()
      .withMessage("Please enter your pincode.")
      .bail()
      .custom((v) => isValidPincode(v))
      .withMessage("Please enter a valid 6-digit Indian pincode."),
  ],
  async (req: any, res: Response) => {
    const userId = req.userId;
    const user = await getUserById(userId);
    if (!user) return res.status(404).send("User not found");

    const errors = validationResult(req);

    const old = {
      email: req.body?.email,
      address: req.body?.address,
      city: req.body?.city,
      state: req.body?.state,
      pincode: req.body?.pincode,
    };

    const emailStr = norm(req.body.email).toLowerCase();
    const addressStr = norm(req.body.address);
    const cityStr = norm(req.body.city);
    const stateStr = norm(req.body.state);
    const pinStr = norm(req.body.pincode);
    const payments = await getGroupedPayments(userId);

    if (!errors.isEmpty()) {
      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "profile",
        user,
        addr: {
          address: addressStr,
          city: cityStr,
          state: stateStr,
          pincode: pinStr,
        },
        payments,
        error: errors.array()[0].msg,
        success: null,
        old,
      });
    }

    try {
      const clash = await pool.query(
          `SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1`,
          [emailStr, userId]
        );

      if (clash.rows.length > 0) {
        return renderProfile(res, {
          activeTab: "profile",
          profileTab: "profile",
          user,
          addr: {
            address: addressStr,
            city: cityStr,
            state: stateStr,
            pincode: pinStr,
          },
          payments,
          error: "This email address is already used by another account.",
          success: null,
          old,
        });
      }

      await pool.query(
        `UPDATE users
         SET email=$1, address=$2, city=$3, state=$4, pincode=$5
         WHERE id=$6`,
        [emailStr, addressStr, cityStr, stateStr, pinStr, userId]
      );

      const updatedUser = await getUserById(userId);

      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "profile",
        user: updatedUser,
        addr: {
          address: updatedUser.address || "",
          city: updatedUser.city || "",
          state: updatedUser.state || "",
          pincode: updatedUser.pincode || "",
        },
        payments: await getGroupedPayments(userId),
        error: null,
        success: "Profile details saved successfully.",
        old: {},
      });
    } catch (e) {
      console.error("Profile update error:", e);
      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "profile",
        user,
        addr: {
          address: addressStr,
          city: cityStr,
          state: stateStr,
          pincode: pinStr,
        },
        payments,
        error: "Something went wrong. Please try again.",
        success: null,
        old,
      });
    }
  }
);

// AJAX password set/reset for logged-in user
router.post("/dashboard/profile/password", authMiddleware, async (req: any, res: Response) => {
  try {
    const userId = req.userId;
    const newPassword = String(req.body.newPassword || "").trim();
    const confirmNewPassword = String(req.body.confirmNewPassword || "").trim();

    if (!newPassword || !confirmNewPassword) {
      return res.status(400).json({
        ok: false,
        message: "Please enter and confirm your new password.",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        message: "New password must be at least 6 characters.",
      });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({
        ok: false,
        message: "New passwords do not match.",
      });
    }

    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        message: "User not found.",
      });
    }

    const passwordHash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users SET password_hash=$1 WHERE id=$2`,
      [passwordHash, userId]
    );

    return res.json({
      ok: true,
      message: "Password reset successfully.",
    });
  } catch (e) {
    console.error("Password reset error:", e);
    return res.status(500).json({
      ok: false,
      message: "Unable to reset password right now. Please try again.",
    });
  }
});

// Raise complaint from My Payments / Help
router.post(
  "/dashboard/help/ticket",
  authMiddleware,
  [
    body("message").trim().isLength({ min: 5, max: 2000 }).withMessage("Please enter a valid message."),
    body("category").optional({ checkFalsy: true }).trim().isLength({ max: 100 }),
    body("transactionRef").optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  ],
  async (req: any, res: Response) => {
    const userId = req.userId;
    const message = norm(req.body.message);
    const category = norm(req.body.category) || "general";
    const transactionRef = norm(req.body.transactionRef) || null;

    const u = await pool.query(
      `SELECT id, name, email, phone, address, city, state, pincode
       FROM users WHERE id=$1 LIMIT 1`,
      [userId]
    );
    if (u.rows.length === 0) return res.status(404).send("User not found");

    const user = u.rows[0];
    const errors = validationResult(req);
    const payments = await getGroupedPayments(userId);

    if (!errors.isEmpty()) {
      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "payments",
        user,
        addr: {
          address: user.address || "",
          city: user.city || "",
          state: user.state || "",
          pincode: user.pincode || "",
        },
        payments,
        error: errors.array()[0].msg,
        success: null,
        old: {},
      });
    }

    try {
      await pool.query(
        `INSERT INTO feedback_tickets
         (user_id, message, phone, category, source, transaction_ref)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, message, user.phone || null, category, "dashboard", transactionRef]
      );

      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "payments",
        user,
        addr: {
          address: user.address || "",
          city: user.city || "",
          state: user.state || "",
          pincode: user.pincode || "",
        },
        payments,
        error: null,
        success: "Your complaint has been submitted successfully.",
        old: {},
      });
    } catch (e) {
      console.error("Feedback ticket create error:", e);
      return renderProfile(res, {
        activeTab: "profile",
        profileTab: "payments",
        user,
        addr: {
          address: user.address || "",
          city: user.city || "",
          state: user.state || "",
          pincode: user.pincode || "",
        },
        payments,
        error: "Unable to submit your complaint right now.",
        success: null,
        old: {},
      });
    }
  }
);

export default router;