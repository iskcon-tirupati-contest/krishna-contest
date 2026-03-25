import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";

export async function authMiddleware(req: any, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;

    if (!token) {
      console.warn("❌ No token", {
        path: req.originalUrl,
        ua: req.headers["user-agent"],
        ip: req.ip,
      });
      return res.redirect("/login");
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("❌ JWT_SECRET missing");
      return res.status(500).send("Server config error");
    }

    let payload: any;

    try {
      payload = jwt.verify(token, secret);
    } catch (err: any) {
      console.error("❌ JWT verify failed", {
        message: err.message,
        name: err.name,
      });

      res.clearCookie("token", { path: "/" });
      return res.redirect("/login");
    }

    const userId = payload?.userId;

    if (!userId) {
      console.warn("❌ Token has no userId", payload);
      res.clearCookie("token", { path: "/" });
      return res.redirect("/login");
    }

    const result = await pool.query(
      `SELECT id, role FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      console.warn("❌ User not found for token", { userId });
      res.clearCookie("token", { path: "/" });
      return res.redirect("/login");
    }

    req.userId = result.rows[0].id;
    req.userRole = result.rows[0].role || "user";

    return next();
  } catch (e: any) {
    console.error("❌ authMiddleware crash", e);
    res.clearCookie("token", { path: "/" });
    return res.redirect("/login");
  }
}