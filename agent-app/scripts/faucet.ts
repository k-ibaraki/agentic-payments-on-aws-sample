// CDP の faucet でテスト USDC / ETH を任意アドレスへ請求する（テストネット専用）。
// 使い方: npx tsx scripts/faucet.ts <アドレス> [usdc|eth]
import { CdpClient } from '@coinbase/cdp-sdk';
import { fileURLToPath } from 'node:url';

// .env（gitignore 済み）から CDP 資格情報を読む。無い場合だけ環境変数のみで続行
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const address = process.argv[2];
const tokenArg = process.argv[3] ?? 'usdc';
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error('使い方: faucet.ts <0x アドレス> [usdc|eth]');
  process.exit(1);
}
if (tokenArg !== 'usdc' && tokenArg !== 'eth') {
  console.error(`トークンは usdc か eth を指定してください（指定: ${tokenArg}）`);
  process.exit(1);
}
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
});
const res = await cdp.evm.requestFaucet({ address, network: 'base-sepolia', token: tokenArg });
console.log(`faucet 請求完了 (${tokenArg}): ${res.transactionHash}`);
console.log(`  https://sepolia.basescan.org/tx/${res.transactionHash}`);
