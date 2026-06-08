// Usage: node scripts/shot.mjs [url]   (default http://127.0.0.1:7340/)
// Screenshots the live Control Room to control-room.png next to this script.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const url = process.argv[2] ?? "http://127.0.0.1:7340/";
let browser;
for (const channel of ["chrome", "msedge", undefined]) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    break;
  } catch {
    /* try next channel */
  }
}
if (!browser) {
  console.error("no chromium-family browser found");
  process.exit(1);
}
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url);
await page.waitForSelector("#connbar.connected", { timeout: 15_000 });
await page.waitForTimeout(500); // let the feed settle
const out = fileURLToPath(new URL("./control-room.png", import.meta.url));
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
