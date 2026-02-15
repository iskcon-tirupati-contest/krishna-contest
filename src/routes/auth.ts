import express from "express";
import { pool } from "../config/db";
import { hashPassword, comparePassword } from "../utils/hash";
import { generateToken } from "../utils/jwt";
import { body, validationResult } from "express-validator";


const router = express.Router();

router.get("/register", (req, res) => {
  res.render("register");
});

router.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body;

  const hashed = await hashPassword(password);

  await pool.query(
    `INSERT INTO users (name, email, phone, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [name, email, phone, hashed]
  );

  res.redirect("/login");
});

router.get("/login", (req, res) => {
  res.render("login");
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    return res.send("User not found");
  }

  const user = result.rows[0];
  const isMatch = await comparePassword(password, user.password_hash);

  if (!isMatch) {
    return res.send("Invalid credentials");
  }

  const token = generateToken(user.id);

  res.cookie("token", token, {
    httpOnly: true,
  });

  res.redirect("/dashboard");
});


router.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/login");
});


export default router;

