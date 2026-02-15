import express from "express";
import path from "path";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { connectDB } from "./config/db";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import participationRoutes from "./routes/participation";

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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

app.use(limiter);

/* Middleware */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

/* Static */
app.use(express.static(path.join(__dirname, "public")));

/* View Engine */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* Routes */
app.use("/", authRoutes);
app.use("/", dashboardRoutes);
app.use("/", participationRoutes);

/* Pages */
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy");
});

app.get("/terms", (req, res) => {
  res.render("terms");
});

app.get("/refund-policy", (req, res) => {
  res.render("refund-policy");
});

app.get("/about", (req, res) => {
  res.render("about");
});

app.get("/contact", (req, res) => {
  res.render("contact");
});

app.get("/payment", (req, res) => {
  res.render("payment");
});

app.get("/payment-success", (req, res) => {
  res.render("payment-success");
});

app.get("/payment-failure", (req, res) => {
  res.render("payment-failure");
});

app.get("/payment-response", (req, res) => {
  res.render("payment-response");
});

app.post("/payment-initiate", (req, res) => {
  res.redirect("/payment-success");
});

app.post("/payment-response", (req, res) => {
  console.log("Gateway Response:", req.body);
  res.redirect("/payment-success");
});

app.get("/test-png", (req, res) => {
  res.sendFile(path.join(__dirname, "public/images/SP_LOGO.png"));
});


connectDB();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

