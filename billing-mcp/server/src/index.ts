// エントリポイント（DESIGN.md 決定19・22・74）。
// Lambda Web Functions は zip の index.js を起動して HTTP サーバーが待ち始めるのを待つ。
// ローカル（pnpm dev）もこのファイルをそのまま動かす。
// 認証は掛けない。認可は x402 の支払いが単独で担う
import { serve } from "@hono/node-server";
import { createMcpFetchHandler, MCP_PATH, optionsFromEnv } from "./app.js";
import { createApp, parseListenAddress } from "./server.js";

const options = optionsFromEnv();
const app = createApp(createMcpFetchHandler(options));
const address = parseListenAddress();

serve({ fetch: app.fetch, ...address }, () =>
  console.log(
    `billing-mcp サーバー起動: http://${address.hostname}:${address.port}${MCP_PATH}（価格は段階制 / facilitator ${options.facilitatorUrl}）`,
  ),
);
