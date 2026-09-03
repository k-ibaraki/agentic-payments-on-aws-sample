// CDP の faucet でテスト USDC / ETH を任意アドレスへ請求する（テストネット専用）。
// 使い方: npx tsx scripts/faucet.ts <アドレス> [usdc|eth]
import { CdpClient } from '@coinbase/cdp-sdk';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {}

const address = process.argv[2];
const token = (process.argv[3] ?? 'usdc') as 'usdc' | 'eth';
if (!address) {
  console.error('使い方: faucet.ts <アドレス> [usdc|eth]');
  process.exit(1);
}
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
});
const res = await cdp.evm.requestFaucet({ address, network: 'base-sepolia', token });
console.log(`faucet 請求完了 (${token}): ${res.transactionHash}`);
console.log(`  https://sepolia.basescan.org/tx/${res.transactionHash}`);
