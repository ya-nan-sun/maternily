import { Agent } from "./agent.ts";
import { createApi } from "./api.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { createExtractor } from "./extraction/index.ts";
import { Pipeline } from "./pipeline.ts";
import { OutboundDispatcher } from "./channels.ts";
import { TelegramPoller, telegramEnabled, telegramSender } from "./telegram.ts";
import { publicUrl, twilioEnabled, twilioSender } from "./twilio.ts";
import { vonageEnabled, vonageSender, vonageWebhookUrls } from "./vonage.ts";
import { metaSender, whatsappEnabled } from "./whatsapp.ts";

const db = openDb();
const extractor = createExtractor();
let pipeline: Pipeline;
const agent = new Agent(db, () => pipeline?.kick());
pipeline = new Pipeline(db, extractor, agent);
pipeline.start();
// Real messaging channels; bursts of agent messages are merged into one (1.5 s).
const outbound = new OutboundDispatcher(db, [metaSender, twilioSender(db), vonageSender(db), telegramSender], 1500);
outbound.start();
const telegram = new TelegramPoller(db, agent, () => pipeline.kick());
void telegram.start();

createApi(db, agent, () => pipeline.kick()).listen(config.port, () => {
  console.log(`Maternily server on http://localhost:${config.port}`);
  console.log(
    whatsappEnabled()
      ? `WhatsApp: on (phone number ID ${config.whatsapp.phoneNumberId}); webhook path /webhook/whatsapp${config.whatsapp.appSecret ? ", signatures checked" : ""}`
      : "WhatsApp: off (set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN)",
  );
  if (!telegramEnabled()) console.log("Telegram: off (set TELEGRAM_BOT_TOKEN)");
  if (vonageEnabled()) {
    const urls = vonageWebhookUrls();
    console.log(`Vonage WhatsApp sandbox: on\n  Inbound URL: ${urls.inbound}\n  Status URL:  ${urls.status}`);
  } else console.log("Vonage WhatsApp: off (set VONAGE_API_KEY and VONAGE_API_SECRET)");
  console.log(
    twilioEnabled()
      ? `Twilio WhatsApp: on (from ${process.env.TWILIO_WHATSAPP_FROM?.trim()}); webhook ${publicUrl() || "<public URL>"}/webhook/twilio`
      : "Twilio WhatsApp: off (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM)",
  );
  if (config.extractor === "template") {
    const who = { none: "the midwife", "claude-code": "headless Claude Code (this laptop's plan)", claude: `Claude API (${config.model})` }[config.aiFallback];
    console.log(`Extractor: local PaddleOCR + form templates (free); unreadable cells → ${who}`);
  } else if (config.extractor === "claude") {
    console.log(`Extractor: Claude (${config.model}, effort ${config.effort})`);
  } else {
    console.log(
      "Extractor: MOCK (no Claude credentials found). Dataset pages are answered from the PDF ground truth with simulated doubts;" +
        " other photos go to manual entry. Set ANTHROPIC_API_KEY to use Claude.",
    );
  }
});
