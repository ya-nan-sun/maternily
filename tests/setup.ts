import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test run gets its own data directory (encrypted images, image key).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "maternily-test-"));
process.env.EXTRACTOR = "mock";
