import express from "express";
import path from "path";
import dotenv from "dotenv";
import { connectDB } from "./config/db";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import participationRoutes from "./routes/participation";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import expressLayouts from "express-ejs-layouts";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP
});

dotenv.config();


const app = express();

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/", authRoutes);
app.use("/", dashboardRoutes);
app.use("/", participationRoutes);
app.disable("x-powered-by");
app.use(expressLayouts);

app.set("layout", "layout");

app.use(express.static('public'));


app.use(limiter);

app.use(helmet({
  contentSecurityPolicy: false
}));


const PORT = 5000;

// View engine setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.set("views", path.join(__dirname, "views"));


connectDB();

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

app.post("/payment-success", (req, res) => {
    res.send("Payment Successful (Test Mode)");
});


app.post("/payment-initiate", (req, res) => {
    // In real integration, redirect to HDFC
    res.redirect("/payment-success");
});


app.get("/payment-response", (req, res) => {
  res.render("payment-response");
});

app.get("/payment-success", (req, res) => {
  res.render("payment-success");
});


app.get("/payment-failure", (req, res) => {
    res.render("payment-failure");
});

// This will be used by HDFC later
app.post("/payment-response", (req, res) => {
    console.log("Gateway Response:", req.body);
    res.redirect("/payment-success");
});


// Start server
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});



