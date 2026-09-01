import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.js";

/** logs/<sessionId>.jsonl に1行追記する。 */
export function saveLog(sessionId, entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${sessionId}.jsonl`);
  fs.appendFileSync(
    logPath,
    JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n",
    "utf-8"
  );
}
