import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";

export const authMiddleware = (req: any, res: Response, next: NextFunction) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect("/login");
  }

  try {
    const decoded: any = verifyToken(token);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.redirect("/login");
  }
};

