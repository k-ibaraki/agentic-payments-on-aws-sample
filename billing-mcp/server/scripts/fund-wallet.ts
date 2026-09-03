// 旧使い捨て買い手ウォレット（BUYER_PRIVATE_KEY）から任意アドレスへ
// Base Sepolia のテスト USDC を送るユーティリティ（フェーズ③ 決定27: 新ウォレットへの資金供給）。
//
// 既定は残高表示のみ（安全側）。送金するときだけ引数を渡す:
//   pnpm tsx scripts/fund-wallet.ts                      # 残高表示のみ
//   pnpm tsx scripts/fund-wallet.ts <宛先> <USDC額>      # 例: 0x8ebB… 1
//
// 注意: ERC-20 の transfer はガス（Base Sepolia ETH）が要る。旧ウォレットの
// ETH 残高もあわせて表示するので、足りなければ ETH の faucet か Circle Faucet 直行を選ぶ
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname);

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) {
  console.error("BUYER_PRIVATE_KEY が .env にありません");
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

async function show(label: string, address: `0x${string}`) {
  const usdc = await publicClient.readContract({
    address: USDC,
    abi: ERC20,
    functionName: "balanceOf",
    args: [address],
  });
  const eth = await publicClient.getBalance({ address });
  console.log(`${label} ${address}`);
  console.log(`  ${formatUnits(usdc, 6)} USDC / ${formatEther(eth)} ETH`);
}

await show("送り元（旧買い手）", account.address);

const to = process.argv[2] as `0x${string}` | undefined;
const amount = process.argv[3];
if (!to || !amount) {
  console.log("");
  console.log("宛先と金額が未指定のため残高表示のみで終了（送金するには: fund-wallet.ts <宛先> <USDC額>）");
  process.exit(0);
}

await show("宛先", to);
console.log("");
console.log(`${amount} USDC を送金します...`);
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
const hash = await walletClient.writeContract({
  address: USDC,
  abi: ERC20,
  functionName: "transfer",
  args: [to, parseUnits(amount, 6)],
});
console.log(`トランザクション: ${hash}`);
console.log(`  https://sepolia.basescan.org/tx/${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`確定: ${receipt.status}`);
await show("宛先（送金後）", to);
