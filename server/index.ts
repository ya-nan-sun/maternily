import { Agent } from "./agent.ts";
import { createApi } from "./api.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { createExtractor } from "./extraction/index.ts";
import { Pipeline } from "./pipeline.ts";

const db = openDb();
const extractor = createExtractor();
let pipeline: Pipeline;
const agent = new Agent(db, () => pipeline?.kick());
pipeline = new Pipeline(db, extractor, agent);
pipeline.start();

createApi(db, agent, () => pipeline.kick()).listen(config.port, () => {
  console.log(`Maternily server on http://localhost:${config.port}`);
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
