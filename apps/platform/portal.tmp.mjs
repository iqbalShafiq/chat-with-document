import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const state = JSON.parse(
  readFileSync(new URL("./e2e/.auth/real-llm-user.json", import.meta.url), "utf8"),
);
const API = "http://localhost:4312";
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();

const signIn = await page.request.post(`${API}/api/auth/sign-in/email`, {
  headers: { origin: "http://localhost:3000", "content-type": "application/json" },
  data: { email: "shafiq@testing.com", password: "Test@123" },
});
let cookie = "";
for (const h of signIn.headersArray()) {
  if (h.name.toLowerCase() !== "set-cookie") continue;
  for (const pair of h.value.split(/,(?=[^ ;]+=)/)) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === "better-auth.session_token") {
      cookie = pair.slice(eq + 1).split(";")[0].trim();
    }
  }
}
await context.addCookies([
  { name: "better-auth.session_token", value: cookie, domain: "localhost", path: "/" },
]);
const list = await page.request.get(`${API}/api/chat/sessions?limit=50`);
const items = ((await list.json()).items ?? []).filter((s) => s.title && !s.title.startsWith("New"));
await page.goto(`http://localhost:3000/chat/${items[0].sessionId}`);
await page.waitForSelector("[data-anvia-composer-editor]", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "Attach document", exact: true }).click();
await page.waitForSelector('[role="menu"]', { timeout: 10000 });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const menu = document.querySelector('[role="menu"]');
  const r = menu.getBoundingClientRect();
  document.body.appendChild(menu);
  menu.style.position = "fixed";
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.top}px`;
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  menu.style.margin = "0";
  menu.style.zIndex = "9999";
});
await page.waitForTimeout(400);
await page.screenshot({ path: "portal-test.png" });
await browser.close();
console.log("saved");
