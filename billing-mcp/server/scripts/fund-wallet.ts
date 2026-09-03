// 旧使い捨て買い手ウォレット（BUYER_PRIVATE_KEY）の残高確認と、任意アドレスへの
// Base Sepolia テスト USDC 送金の補助ユーティリティ。
//
// 位置づけ: フェーズ③の資金供給の主経路は agent-app/scripts/faucet.ts（CDP faucet）で、
// この送金経路は決定27 の変更②で不採用になった（旧買い手にガス用 ETH が無く送金できない）。
// 旧買い手に ETH を入れた場合の補助手段と、残高確認のために残している。
//
// 既定は残高表示のみ（安全側）。送金するときだけ引数を渡す:
//   pnpm tsx scripts/fund-wallet.ts                      # 残高表示のみ
//   pnpm tsx scripts/fund-wallet.ts <宛先> <USDC額>      # 例: 0x4288… 1
//
// 注意: ERC-20 の transfer はガス（Base Sepolia ETH）が要る。旧ウォレットの
// ETH 残高もあわせて表示する

import { fileURLToPath } from "node:url";
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

process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

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
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

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

const toArg = process.argv[2];
const amount = process.argv[3];
if (!toArg || !amount) {
  console.log("");
  console.log(
    "宛先と金額が未指定のため残高表示のみで終了（送金するには: fund-wallet.ts <宛先> <USDC額>）",
  );
  process.exit(0);
}
// 送金は取り消せないので、宛先と金額の形式は先に弾く
if (!/^0x[0-9a-fA-F]{40}$/.test(toArg)) {
  console.error(`宛先が EVM アドレスの形式ではありません: ${toArg}`);
  process.exit(1);
}
if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
  console.error(
    `金額は USDC 単位の数値（小数6桁まで）で指定してください: ${amount}`,
  );
  process.exit(1);
}
const to = toArg as `0x${string}`;

await show("宛先", to);
console.log("");
console.log(`${amount} USDC を送金します...`);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});
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
// revert を成功扱いにしない（後続の検証が原因不明で落ちるのを防ぐ）
if (receipt.status !== "success") {
  console.error(
    "送金トランザクションが revert しました（残高・ガスを確認してください）",
  );
  process.exit(1);
}
