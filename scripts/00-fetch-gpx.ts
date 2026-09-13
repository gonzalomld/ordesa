// 00-fetch-gpx.ts — download the primary track source and version it in git.
// The URL can die; the file in data/source/ is what the pipeline uses.
import { existsSync } from "node:fs";
import { GPX_FILE, GPX_URL, WMS_MAX_ATTEMPTS, WMS_RETRY_BASE_MS } from "./geo-constants.ts";
import { downloadCached } from "./lib/http.ts";

const force = process.argv.includes("--force");
if (existsSync(GPX_FILE) && !force) {
  console.log(`cached: ${GPX_FILE} (use --force to re-download)`);
  process.exit(0);
}

console.log(`fetching GPX: ${GPX_URL}`);
await downloadCached(GPX_URL, GPX_FILE, WMS_MAX_ATTEMPTS, WMS_RETRY_BASE_MS, true);
