import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test run gets its own data directory (encrypted images, image key).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "maternily-test-"));
process.env.EXTRACTOR = "mock";
// WhatsApp adapter tests talk to a stubbed Graph API, never to Meta.
process.env.WHATSAPP_PHONE_NUMBER_ID = "100000000000001";
process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify";
process.env.AI_FALLBACK = "none";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "twilio-test-token";
process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
process.env.PUBLIC_URL = "https://demo.example";
process.env.VONAGE_API_KEY = "vonage-key";
process.env.VONAGE_API_SECRET = "vonage-secret";
