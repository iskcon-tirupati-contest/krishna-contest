// src/routes/profile.ts

import express, { Response } from "express";
import { body, validationResult } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import { pool } from "../config/db";

const router = express.Router();

const norm = (v: any) => String(v ?? "").trim();
const isValidIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(norm(v));
const isValidPincode = (v: string) => /^[1-9]\d{5}$/.test(norm(v));

function renderProfile(res: Response, data: any) {
  return res.render("dashboard-profile", data);
}

// GET profile
router.get("/dashboard/profile", authMiddleware, async (req: any, res: Response) => {
  const userId = req.userId;

  const u = await pool.query(
    `SELECT id, name, email, phone, phone_locked, role, address, city, state, pincode
     FROM users WHERE id=$1`,
    [userId]
  );

  if (u.rows.length === 0) return res.status(404).send("User not found");

  const user = u.rows[0];

  return renderProfile(res, {
    activeTab: "profile",
    user,
    addr: {
      address: user.address || "",
      city: user.city || "",
      state: user.state || "",
      pincode: user.pincode || "",
    },
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
    // phone can be set only if empty currently
    body("phone")
      .optional({ checkFalsy: true })
      .custom((v) => isValidIndianMobile(v))
      .withMessage("Please enter a valid 10-digit Indian mobile number (starts with 6-9)."),

    body("confirmPhone")
      .optional({ checkFalsy: true })
      .custom((v, { req }) => norm(v) === norm(req.body.phone))
      .withMessage("Mobile numbers do not match."),

    body("address").optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage("Address is too long."),
    body("city").optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage("City is too long."),
    body("state").optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage("State is too long."),
    body("pincode")
      .optional({ checkFalsy: true })
      .custom((v) => isValidPincode(v))
      .withMessage("Please enter a valid 6-digit Indian pincode."),
  ],
  async (req: any, res: Response) => {
    const userId = req.userId;

    const u = await pool.query(
      `SELECT id, name, email, phone, phone_locked, role, address, city, state, pincode
       FROM users WHERE id=$1`,
      [userId]
    );
    if (u.rows.length === 0) return res.status(404).send("User not found");

    const user = u.rows[0];

    const errors = validationResult(req);

    const old = {
      phone: req.body?.phone,
      confirmPhone: req.body?.confirmPhone,
      address: req.body?.address,
      city: req.body?.city,
      state: req.body?.state,
      pincode: req.body?.pincode,
    };

    const phoneStr = norm(req.body.phone);
    const addressStr = norm(req.body.address);
    const cityStr = norm(req.body.city);
    const stateStr = norm(req.body.state);
    const pinStr = norm(req.body.pincode);

    const addr = { address: addressStr, city: cityStr, state: stateStr, pincode: pinStr };

    if (!errors.isEmpty()) {
      return renderProfile(res, {
        activeTab: "profile",
        user,
        addr,
        error: errors.array()[0].msg,
        success: null,
        old,
      });
    }

    try {
      // PHONE RULE:
      const existingPhone = norm(user.phone);

      if (phoneStr) {
        if (existingPhone && existingPhone !== phoneStr) {
          return renderProfile(res, {
            activeTab: "profile",
            user,
            addr,
            error: "Mobile number cannot be changed once saved. Please contact support via WhatsApp.",
            success: null,
            old,
          });
        }

        if (!existingPhone) {
          const clash = await pool.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [phoneStr]);
          if (clash.rows.length > 0) {
            return renderProfile(res, {
              activeTab: "profile",
              user,
              addr,
              error: "This mobile number is already registered. Please login with that account.",
              success: null,
              old,
            });
          }

          await pool.query(`UPDATE users SET phone=$1, phone_locked=true WHERE id=$2`, [phoneStr, userId]);
        }
      }

      // Save default address anytime
      await pool.query(
        `UPDATE users
         SET address=$1, city=$2, state=$3, pincode=$4
         WHERE id=$5`,
        [addressStr || null, cityStr || null, stateStr || null, pinStr || null, userId]
      );

      const updated = await pool.query(
        `SELECT id, name, email, phone, phone_locked, role, address, city, state, pincode
         FROM users WHERE id=$1`,
        [userId]
      );

      return renderProfile(res, {
        activeTab: "profile",
        user: updated.rows[0],
        addr: {
          address: updated.rows[0].address || "",
          city: updated.rows[0].city || "",
          state: updated.rows[0].state || "",
          pincode: updated.rows[0].pincode || "",
        },
        error: null,
        success: "Saved successfully.",
        old: {},
      });
    } catch (e) {
      console.error("Profile update error:", e);
      return renderProfile(res, {
        activeTab: "profile",
        user,
        addr,
        error: "Something went wrong. Please try again.",
        success: null,
        old,
      });
    }
  }
);

export default router;
