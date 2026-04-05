import { Response, NextFunction } from "express";
import { pool } from "../config/db";

export async function agentMiddleware(req: any, res: Response, next: NextFunction) {
  try {
    const userId = req.userId;
    if (!userId) return res.redirect("/login");

    const q = await pool.query(`SELECT role FROM users WHERE id=$1`, [userId]);
    const role = q.rows[0]?.role || "user";

    if (role !== "agent") return res.status(403).send("Forbidden: Agents only");
    next();
  } catch (e) {
    console.error("agentMiddleware error:", e);
    return res.status(500).send("Server error");
  }
}