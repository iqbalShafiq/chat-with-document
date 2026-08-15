import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getListenHostname, listLanIpv4Addresses } from "./lib/origins.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3001);
const hostname = getListenHostname();

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
