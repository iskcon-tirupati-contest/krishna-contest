// src/routes/IVR.ts
import express from "express";
import {
  sendIvrContestLinkMessage,
  sendIvrBookTrackingMessage,
  sendIvrEssayHelpMessage,
  sendIvrComplaintMessage,
  sendIvrTeluguContestLinkMessage,
  sendIvrTeluguBookTrackingMessage,
  sendIvrTeluguEssayHelpMessage,
  sendIvrTeluguComplaintMessage,
} from "../services/contestConfirmation";

const router = express.Router();

function normalizeIndianMobile(raw: string): string {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exotel sends CallerNumber + digits pressed
// Set Passthru URL in Exotel to:
//   https://krishnacontest.org/exotel/ivr/handler?key={digits}
//
// Keypress map:
//   1 → Ramayana registration link
//   2 → Bhagavatam registration link
//   3 → Krishna registration link
//   4 → Bhagavad Gita registration link
//   5 → Combo registration link
//   6 → Book tracking status
//   7 → Essay submission help (video)
//   8 → Raise a complaint (form link)
//   9 → Talk to agent  ← handled entirely in Exotel via Transfer applet, never hits here
// ─────────────────────────────────────────────────────────────────────────────

async function handleIvrRequest(req: any, res: any) {
  // Always respond 200 immediately — Passthru is async, Exotel doesn't wait
  res.status(200).send("ok");

  try {
    console.log("IVR HANDLER HIT:", req.method, "body:", req.body, "query:", req.query);

    // Extract caller number from Exotel payload
    const rawPhone =
      req.body?.From ||
      req.body?.from ||
      req.query?.From ||
      req.query?.from ||
      req.body?.CallFrom ||
      req.query?.CallFrom ||
      "";

    const phone = normalizeIndianMobile(String(rawPhone || ""));

    if (!phone) {
      console.warn("IVR: No caller number received");
      return;
    }

    // Extract keypress digit — from query param (Option B: ?key={digits})
    // or fallback to body digits field that Exotel may send
    const key =
      String(req.query?.key || req.query?.digits || req.body?.digits || "").trim();

    // lang=te → Telugu, lang=en or missing → English (backward compatible)
    const lang = String(req.query?.lang || req.body?.lang || "en").trim().toLowerCase();
    const isTelugu = lang === "te";

    console.log(`IVR: phone=${phone} key=${key} lang=${lang}`);

    let result: any;

    switch (key) {
      case "1":
        result = isTelugu
          ? await sendIvrTeluguContestLinkMessage(phone, "ramayana")
          : await sendIvrContestLinkMessage(phone, "ramayana");
        break;
      case "2":
        result = isTelugu
          ? await sendIvrTeluguContestLinkMessage(phone, "bhagavatam")
          : await sendIvrContestLinkMessage(phone, "bhagavatam");
        break;
      case "3":
        result = isTelugu
          ? await sendIvrTeluguContestLinkMessage(phone, "krishna")
          : await sendIvrContestLinkMessage(phone, "krishna");
        break;
      case "4":
        result = isTelugu
          ? await sendIvrTeluguContestLinkMessage(phone, "gita")
          : await sendIvrContestLinkMessage(phone, "gita");
        break;
      case "5":
        result = isTelugu
          ? await sendIvrTeluguContestLinkMessage(phone, "combo")
          : await sendIvrContestLinkMessage(phone, "combo");
        break;
      case "6":
        result = isTelugu
          ? await sendIvrTeluguBookTrackingMessage(phone)
          : await sendIvrBookTrackingMessage(phone);
        break;
      case "7":
        result = isTelugu
          ? await sendIvrTeluguEssayHelpMessage(phone)
          : await sendIvrEssayHelpMessage(phone);
        break;
      case "8":
        result = isTelugu
          ? await sendIvrTeluguComplaintMessage(phone)
          : await sendIvrComplaintMessage(phone);
        break;
      case "9":
        // Agent transfer — handled in Exotel, should never reach here
        console.log(`IVR: key=9 lang=${lang} agent transfer for ${phone} (handled by Exotel Transfer applet)`);
        return;
      default:
        console.warn(`IVR: Unknown key="${key}" lang=${lang} from phone=${phone}`);
        return;
    }

    console.log(`IVR: key=${key} phone=${phone} result:`, result);
  } catch (err) {
    console.error("IVR handler error:", err);
  }
}

router.get("/exotel/ivr/handler", handleIvrRequest);
router.post("/exotel/ivr/handler", handleIvrRequest);

// Keep old route alive during transition — maps to combo (key=5) as fallback
router.get("/exotel/ivr/registration", (req: any, res: any) => {
  req.query.key = req.query.key || "1";
  return handleIvrRequest(req, res);
});
router.post("/exotel/ivr/registration", (req: any, res: any) => {
  req.body = req.body || {};
  req.query.key = req.query.key || "1";
  return handleIvrRequest(req, res);
});

export default router;