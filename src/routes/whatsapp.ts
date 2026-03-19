import express, { Request, Response } from "express";
import { pool } from "../config/db";

const router = express.Router();

function normalizePhone(input: string) {
  const digits = String(input || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeMessage(input: string) {
  return String(input || "").trim().toLowerCase();
}

async function findUserByPhone(phone: string) {
  const q = await pool.query(
    `SELECT id, name, email, phone
     FROM users
     WHERE phone = $1
     LIMIT 1`,
    [phone]
  );
  return q.rows[0] || null;
}

async function createWhatsappUser(phone: string) {
  const q = await pool.query(
    `INSERT INTO users (phone, phone_locked)
     VALUES ($1, true)
     ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id, name, email, phone`,
    [phone]
  );
  return q.rows[0];
}

async function userHasPaidContest(userId: string) {
  const q = await pool.query(
    `SELECT o.id
     FROM orders o
     WHERE o.user_id = $1
       AND LOWER(COALESCE(o.payment_status, 'pending')) = 'paid'
     LIMIT 1`,
    [userId]
  );
  return q.rows.length > 0;
}

async function getPaidContestSummary(userId: string) {
  const q = await pool.query(
    `SELECT c.title, o.created_at
     FROM orders o
     JOIN contests c ON c.id = o.contest_id
     WHERE o.user_id = $1
       AND LOWER(COALESCE(o.payment_status, 'pending')) = 'paid'
     ORDER BY o.created_at DESC
     LIMIT 3`,
    [userId]
  );
  return q.rows;
}

/**
 * POST /api/whatsapp/resolve-entry
 * Body:
 * {
 *   "phone": "919876543210",
 *   "message": "Join"
 * }
 */

router.post("/resolve-entry", async (req, res) => {
  try {
    console.log("=== resolve-entry HIT ===");
    console.log("method:", req.method);
    console.log("body:", req.body);
    console.log("query:", req.query);

    const rawPhone = String(req.body?.phone ?? req.query?.phone ?? "").trim();
    const rawMessage = String(req.body?.message ?? req.query?.message ?? "").trim();

    console.log("rawPhone:", rawPhone);
    console.log("rawMessage:", rawMessage);

    const phone = rawPhone.replace(/\D/g, "");
    const message = rawMessage.toLowerCase();

    if (!phone) {
      return res.status(400).json({
        ok: false,
        message: "Phone is required",
      });
    }

    if (message !== "join") {
      return res.json({
        ok: true,
        message: "Please send Join to continue.",
      });
    }

    const existing = await pool.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [phone]
    );

    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (phone, phone_locked)
         VALUES ($1, false)`,
        [phone]
      );
    }

    return res.json({
      ok: true,
      login_url: "https://iskconcontest.org/login",
      message: "Please click below to login111: https://iskconcontest.org/login"
    });
  } catch (err) {
    console.error("resolve-entry error:", err);
    return res.status(500).json({
      ok: false,
      message: "Something went wrong. Please try again later.",
    });
  }
});

router.post("/test-hit", async (req, res) => {
  console.log("🔥 TEST API HIT 🔥");
  console.log("time:", new Date().toISOString());

  return res.json({
    ok: true,
    message: "API HIT SUCCESS"
  });
});



function toIndianLocalMobile(raw: string): string {
  let phone = String(raw || "").replace(/\D/g, "");

  if (phone.startsWith("91") && phone.length === 12) {
    phone = phone.slice(2);
  }

  return phone;
}

async function sendLoginLink(rawPhone: string) {
  try {
    const authKey = process.env.OMNLY_AUTHKEY || "";
    const wid = "29171";

    const phone = toIndianLocalMobile(rawPhone);
    const loginUrl = "https://iskconcontest.org/login";

    const url =
      `https://panel.omnly.in/restapi/request.php` +
      `?authkey=${encodeURIComponent(authKey)}` +
      `&mobile=${encodeURIComponent(phone)}` +
      `&country_code=91` +
      `&wid=${wid}` +
      `&1=${encodeURIComponent(loginUrl)}`;

    console.log("📤 Sending:", url);

    const res = await fetch(url);
    const data = await res.text();

    console.log("📤 Response:", data);
  } catch (err) {
    console.error("❌ Send error:", err);
  }
}

router.post("/incoming", async (req, res) => {
  try {
    console.log("📩 MY WEBHOOK HIT");

    const msgObj = req.body?.eventContent?.message;

    const rawPhone = String(msgObj?.from || "").replace(/\D/g, "");
    const phoneForDb = toIndianLocalMobile(rawPhone);
    const message = String(msgObj?.text?.body || "").trim().toLowerCase();

    console.log("rawPhone:", rawPhone);
    console.log("phoneForDb:", phoneForDb);
    console.log("message:", message);

    if (!phoneForDb) return res.sendStatus(200);

    if (message === "join") {
      const existing = await pool.query(
        `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
        [phoneForDb]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO users (phone, phone_locked)
           VALUES ($1, false)`,
          [phoneForDb]
        );
      }

      await sendLoginLink(rawPhone);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("webhook error:", err);
    return res.sendStatus(200);
  }
});


router.all("/debug", async (req, res) => {
  return res.json({
    method: req.method,
    body: req.body,
    query: req.query
  });
});

/**
 * POST /api/whatsapp/resolve-menu
 * Body:
 * {
 *   "phone": "919876543210",
 *   "message": "hi"
 * }
 */
router.post("/resolve-menu", async (req: Request, res: Response) => {
  try {
    const rawPhone = (req.body?.phone ?? req.query?.phone ?? "") as string;
    const rawMessage = (req.body?.message ?? req.query?.message ?? "") as string;

    const phone = normalizePhone(rawPhone);
    const message = normalizeMessage(rawMessage);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        message: "Phone is required",
      });
    }

    const user = await findUserByPhone(phone);

    if (!user) {
      return res.json({
        ok: true,
        menuType: "public",
        title: "Welcome to Krishna Cultural Contest 🙏",
        buttons: [
          "Register Now",
          "View Available Contests",
          "Payment Issues",
        ],
        message: "Please choose an option below.",
      });
    }

    const hasPaid = await userHasPaidContest(user.id);

    if (hasPaid) {
      return res.json({
        ok: true,
        menuType: "registered_paid",
        title: "Welcome back 🙏",
        buttons: [
          "My Contests",
          "Payment Status",
          "Support",
        ],
        message: "Please choose an option below.",
      });
    }

    return res.json({
      ok: true,
      menuType: "registered_no_paid",
      title: "Welcome back 🙏",
      buttons: [
        "Register Now",
        "View Available Contests",
        "Support",
      ],
      message: "Please choose an option below.",
    });
  } catch (err) {
    console.error("resolve-menu error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
});

/**
 * POST /api/whatsapp/menu-action
 * Body:
 * {
 *   "phone": "919876543210",
 *   "selection": "My Contests"
 * }
 */
router.post("/menu-action", async (req: Request, res: Response) => {
  try {

    const rawPhone = (req.body?.phone ?? req.query?.phone ?? "") as string;
const rawSelection = (req.body?.selection ?? req.query?.selection ?? "") as string;

const phone = normalizePhone(rawPhone);
const selection = String(rawSelection || "").trim();


    if (!phone) {
      return res.status(400).json({
        ok: false,
        message: "Phone is required",
      });
    }

    const user = await findUserByPhone(phone);

    switch (selection) {
      case "Register Now":
        return res.json({
          ok: true,
          action: "open_url",
          url: "/",
          message: "Please explore the available contests and register.",
        });

      case "View Available Contests":
        return res.json({
          ok: true,
          action: "open_url",
          url: "/",
          message: "Please explore the available contests on the website.",
        });

      case "My Contests":
        return res.json({
          ok: true,
          action: "open_url",
          url: "/dashboard",
          message: "Opening your dashboard / My Contests.",
        });

      case "Payment Status": {
        if (!user) {
          return res.json({
            ok: true,
            action: "message",
            message: "User not found. Please register first.",
          });
        }

        const paidContests = await getPaidContestSummary(user.id);

        if (!paidContests.length) {
          return res.json({
            ok: true,
            action: "message",
            message: "No paid contest registrations found yet.",
          });
        }

        const lines = paidContests.map((x: any, i: number) => `${i + 1}. ${x.title}`);
        return res.json({
          ok: true,
          action: "message",
          message: `Your paid contest registrations:\n\n${lines.join("\n")}`,
        });
      }

      case "Payment Issues":
        return res.json({
          ok: true,
          action: "message",
          message:
            "Please share your name, transaction ID and payment screenshot. Our team will help you.",
        });

      case "Support":
        return res.json({
          ok: true,
          action: "message",
          message:
            "Please type your issue in detail. Our support team will get back to you.",
        });

      default:
        return res.json({
          ok: true,
          action: "message",
          message: "Please choose a valid option.",
        });
    }
  } catch (err) {
    console.error("menu-action error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
});

export default router;