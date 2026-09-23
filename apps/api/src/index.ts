import { serve } from "@hono/node-server";
import { createApp, startRunStaleWatchdog } from "./app.js";
import { getListenHostname, listLanIpv4Addresses } from "./lib/origins.js";
import { resolveCredentialsKey } from "./modules/mcp-servers/credentials.js";

const app = createApp();
// Fail fast in production when the MCP credential vault has no key.
resolveCredentialsKey();
const port = Number(process.env.PORT ?? 3001);
const hostname = getListenHostname();
startRunStaleWatchdog();

serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    const urls = [
      `http://localhost:${info.port}`,
      ...listLanIpv4Addresses().map((ip) => `http://${ip}:${info.port}`),
    ];
    for (const url of urls) {
      console.log(`Server is running on ${url}`);
    }
    console.log(`API reference: ${urls[0]}/scalar`);
    console.log(`OpenAPI document: ${urls[0]}/doc`);
    if (urls.length > 1) {
      console.log(`LAN docs: ${urls[1]}/scalar`);
    }
  },
);
