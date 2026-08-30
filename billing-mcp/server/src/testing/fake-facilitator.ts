// テスト用の偽 facilitator（x402.org の代役）。/supported /verify /settle を提供する。
// 本番コードからは参照しない（バンドルにも含まれない）
import type { Server } from "node:http";
import express from "express";

export interface FacilitatorLog {
  verify: unknown[];
  settle: unknown[];
}

export interface FakeFacilitator {
  url: string;
  log: FacilitatorLog;
  /** 次の settle だけ失敗させる（実測で起きた一過性エラーの再現） */
  failNextSettle: () => void;
  close: () => void;
}

export function startFakeFacilitator(): Promise<FakeFacilitator> {
  const app = express();
  app.use(express.json());
  const log: FacilitatorLog = { verify: [], settle: [] };
  let settleShouldFail = false;

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    });
  });
  app.post("/verify", (req, res) => {
    log.verify.push(req.body);
    res.json({
      isValid: true,
      payer: "0x1111111111111111111111111111111111111111",
    });
  });
  app.post("/settle", (req, res) => {
    log.settle.push(req.body);
    if (settleShouldFail) {
      settleShouldFail = false;
      res.json({
        success: false,
        errorReason: "invalid_exact_evm_transaction_failed",
        transaction: "",
        network: "eip155:84532",
      });
      return;
    }
    res.json({
      success: true,
      transaction: "0xfaketx",
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
    });
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        log,
        failNextSettle: () => {
          settleShouldFail = true;
        },
        close: () => server.close(),
      });
    });
  });
}
