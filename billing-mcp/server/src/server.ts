import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import {
  createBillingMcpServer,
  createPaidWrapper,
  DEFAULT_PRICE,
} from "./billing-mcp-server.js";

const facilitatorUrl =
  process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const payTo = process.env.PAY_TO_ADDRESS as `0x${string}` | undefined;
if (!payTo) {
  console.error("環境変数 PAY_TO_ADDRESS（売上受取ウォレット）が必要です");
  process.exit(1);
}
const price = process.env.PRICE ?? DEFAULT_PRICE;

// facilitator への /supported 照会を伴うため、起動時に1度だけ構築して
// 全セッションで共有する
const sharedPaid = await createPaidWrapper({ facilitatorUrl, payTo, price });

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

const app = express();
app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));
// 添付ファイル3件 × 4.5MB を base64（約33%増）で受け取れる上限
app.use(express.json({ limit: "25mb" }));

app.post("/mcp", async (req, res) => {
  const raw = req.headers["mcp-session-id"];
  const existingSessionId = Array.isArray(raw) ? raw[0] : raw;

  if (existingSessionId && mcpTransports.has(existingSessionId)) {
    const transport = mcpTransports.get(existingSessionId);
    if (transport) await transport.handleRequest(req, res, req.body);
    return;
  }

  if (existingSessionId && !mcpTransports.has(existingSessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
    onsessioninitialized: (sessionId) => {
      mcpTransports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) mcpTransports.delete(transport.sessionId);
  };

  const server = await createBillingMcpServer(
    { facilitatorUrl, payTo, price },
    sharedPaid,
  );
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const raw = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  if (sessionId && mcpTransports.has(sessionId)) {
    await mcpTransports.get(sessionId)?.handleRequest(req, res);
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

app.delete("/mcp", async (req, res) => {
  const raw = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  if (sessionId) {
    const transport = mcpTransports.get(sessionId);
    if (transport) {
      await transport.close().catch(() => {});
      mcpTransports.delete(sessionId);
    }
  }
  res.status(200).json({ ok: true });
});

// AgentCore Runtime の MCP 契約はポート 8000 の /mcp
const PORT = Number.parseInt(process.env.PORT ?? "8000", 10);
app.listen(PORT, () =>
  console.log(
    `billing-mcp サーバー起動: http://localhost:${PORT}/mcp（価格 ${price} / facilitator ${facilitatorUrl}）`,
  ),
);
