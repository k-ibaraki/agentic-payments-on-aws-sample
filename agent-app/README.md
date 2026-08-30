# agent-app（買い手: MCP を実行する Agent + 制御 Web アプリ）

AWS Blocks 製。billing-mcp の有料ツールを AgentCore Payments のウォレットで x402 支払いしながら実行するエージェントと、
その制御・MCP Apps UI（iframe）表示を行う Web アプリ。実装はこれから。

## 立ち上げ方針

- 雛形は AWS Blocks のスキャフォールドで生成する（手書きで模倣しない）。パッケージマネージャもスキャフォールドに従う（npm 想定。DESIGN.md 決定15）
- 生成後はスキャフォールドが吐く AGENTS.md と aws-blocks スキルの規約に従う
- 使用予定ブロック: Agent / AuthCognito / KVStore / ApiNamespace（確定したら DESIGN.md へ記録）
- ウォレット（AgentCore Payments）は ap-southeast-1 に作成し、Agent（Lambda）からクロスリージョンで呼ぶ（DESIGN.md 決定12・U1・U2 参照）
