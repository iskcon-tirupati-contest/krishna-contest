import express from "express";
import path from "path";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";

import { connectDB, pool } from "./config/db";

import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import participationRoutes from "./routes/participation";
import checkoutRoutes from "./routes/checkout";
import paymentRoutes from "./routes/payment";
import profileRoutes from "./routes/profile";
import adminRoutes from "./routes/admin";
import cors from "cors";
dotenv.config();

const app = express();
const PORT = 5000;

/* Security */
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 600 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: "We’re receiving too many requests from this network right now. Please wait a moment and try again.",
  skip: (req) => {
    return req.path.startsWith("/images") || req.path.startsWith("/public");
  },
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many attempts detected. Please wait a few minutes and try again.",
});

app.use(generalLimiter);
app.use("/login",sensitiveLimiter);
app.use("/register",sensitiveLimiter);
app.use("/dashboard/help/ticket",sensitiveLimiter);


app.use("/register/send-otp", sensitiveLimiter);
app.use("/register/verify-otp", sensitiveLimiter);
app.use("/forgot-password/send-otp", sensitiveLimiter);
app.use("/forgot-password/verify-otp", sensitiveLimiter);
app.use("/forgot-password/reset", sensitiveLimiter);

/* Middleware */
// Razorpay webhooks need the raw body for signature verification
app.use('/payment/hdfc/webhook', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

/* Static */
app.use(express.static(path.join(__dirname, "public")));

/* View Engine */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* Google OAuth (no session; we still use JWT cookie) */
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "",
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = (profile.emails && profile.emails[0]?.value
          ? profile.emails[0].value
          : ""
        ).toLowerCase();
        const name = profile.displayName || "Devotee";

        if (!email) return done(null, false);

        const byGoogle = await pool.query(
          `SELECT id FROM users WHERE google_id=$1 LIMIT 1`,
          [googleId]
        );
        if (byGoogle.rows.length > 0) return done(null, { id: byGoogle.rows[0].id });

        const byEmail = await pool.query(
          `SELECT id, google_id FROM users WHERE email=$1 LIMIT 1`,
          [email]
        );
        if (byEmail.rows.length > 0) {
          const uid = byEmail.rows[0].id;
          if (!byEmail.rows[0].google_id) {
            await pool.query(`UPDATE users SET google_id=$1 WHERE id=$2`, [googleId, uid]);
          }
          return done(null, { id: uid });
        }

        const created = await pool.query(
          `INSERT INTO users (name, email, google_id, phone_locked)
           VALUES ($1,$2,$3,false)
           RETURNING id`,
          [name, email, googleId]
        );

        return done(null, { id: created.rows[0].id });
      } catch (e) {
        console.error("Google OAuth error:", e);
        return done(e as any, false);
      }
    }
  )
);

app.use(passport.initialize());

/* Routes */
app.use("/", authRoutes);
app.use("/", dashboardRoutes);
app.use("/", participationRoutes);
app.use(checkoutRoutes);
app.use(paymentRoutes);
app.use("/", profileRoutes);
app.use("/", adminRoutes);

/* Pages */

//app.get("/", (_req, res) => res.render("index"));

app.get("/", async (_req, res) => {
  const contestsRes = await pool.query(`
    SELECT
      id,
      title,
      description,
      price,
      registration_deadline,
      submission_deadline,
      winner_declaration_date,
      image_url,
      prize_details,
      rules,
      age_categories,
      participant_benefits
    FROM contests
    WHERE is_active = true
    ORDER BY title ASC
  `);

  res.render("index", {
    contests: contestsRes.rows
  });
});
app.get("/privacy-policy", (_req, res) => res.render("privacy-policy"));
app.get("/terms", (_req, res) => res.render("terms"));
app.get("/refund-policy", (_req, res) => res.render("refund-policy"));
app.get("/about", (_req, res) => res.render("about"));
app.get("/contact", (_req, res) => res.render("contact"));

connectDB();

app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
