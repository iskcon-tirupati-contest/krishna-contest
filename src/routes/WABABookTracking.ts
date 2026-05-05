// src/routes/WABABookTracking.ts
import express from "express";
import { sendIvrBookTrackingMessage, sendIvrTeluguBookTrackingMessage } from "../services/contestConfirmation";

const router = express.Router();

function normalizePhone(raw: string): string {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}

function extractPhone(req: any): string {
  const queryPhone = req.query?.phone;
  const candidates = Array.isArray(queryPhone) ? queryPhone : [queryPhone];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const str = String(candidate);
    if (str.includes("{{") || str === "MobileNumber") continue;
    const phone = normalizePhone(str);
    if (phone.length === 10) return phone;
  }

  return "";
}

async function handleWabaBookTracking(req: any, res: any) {
  res.status(200).json({ success: true });

  try {
    const phone = extractPhone(req);

    if (!phone) {
      console.warn("WABA BOOK TRACKING: Could not extract valid phone:", req.query);
      return;
    }

    const lang = String(req.query?.lang || "en").trim().toLowerCase();
    const isTelugu = lang === "te";

    console.log(`WABA BOOK TRACKING: phone=${phone} lang=${lang}`);

    const result = isTelugu
      ? await sendIvrTeluguBookTrackingMessage(phone)
      : await sendIvrBookTrackingMessage(phone);

    console.log(`WABA BOOK TRACKING: Done for phone=${phone}`, result);
  } catch (err) {
    console.error("WABA BOOK TRACKING error:", err);
  }
}

router.post("/waba/book-tracking", handleWabaBookTracking);
router.get("/waba/book-tracking",  handleWabaBookTracking);

export default router;