import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";

export async function authMiddleware(req: any, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.redirect("/login");

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).send("Server config error");

    const payload: any = jwt.verify(token, secret);
    const userId = payload.userId || payload.id || payload;
    if (!userId) return res.redirect("/login");

    // fetch role from DB (source of truth)
    const u = await pool.query(`SELECT id, role FROM users WHERE id=$1`, [userId]);
    if (u.rows.length === 0) {
      res.clearCookie("token", { path: "/" });
      return res.redirect("/login");
    }

    req.userId = u.rows[0].id;
    req.userRole = u.rows[0].role || "user";

    next();
  } catch (e) {
    res.clearCookie("token", { path: "/" });
    return res.redirect("/login");
  }
}
