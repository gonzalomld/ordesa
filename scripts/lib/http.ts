// Polite HTTP helpers for the IGN services (public, free — don't hammer them).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function fetchWithRetry(
  url: string,
  attempts: number,
  baseMs: number,
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (i < attempts) {
      const wait = baseMs * 2 ** (i - 1);
      console.log(`  attempt ${i} failed, retrying in ${wait} ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** Download url to dest unless it already exists (use --force to re-download). */
export async function downloadCached(
  url: string,
  dest: string,
  attempts: number,
  baseMs: number,
  force = process.argv.includes("--force"),
): Promise<boolean> {
  if (existsSync(dest) && !force) {
    console.log(`  cached: ${dest} (use --force to re-download)`);
    return false;
  }
  const res = await fetchWithRetry(url, attempts, baseMs);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`  saved: ${dest} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  return true;
}
