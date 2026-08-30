// 合成した Lambda バンドルが「読み込める」ことだけを確かめる。
//
// ESM 出力に CJS 配布の依存（AWS SDK v3 等）を同梱すると、実行時に
// 「Dynamic require of "node:stream" is not supported」で落ちる。これは
// デプロイするまで露見しないため、synth 直後にここで潰す。
// 読み込むだけなのでネットワークも環境変数も要らない（ハンドラ生成は遅延）
import fs from "node:fs";
import path from "node:path";

const outDir = path.join(import.meta.dirname, "..", "cdk.out");
if (!fs.existsSync(outDir)) {
  console.error("cdk.out がありません。先に cdk synth を実行してください");
  process.exit(1);
}

const assetDirs = fs
  .readdirSync(outDir)
  .filter((name) => name.startsWith("asset."))
  .map((name) => path.join(outDir, name))
  .filter((dir) => fs.existsSync(path.join(dir, "index.mjs")));

if (assetDirs.length === 0) {
  console.error("cdk.out に Lambda のバンドル（index.mjs）が見つかりません");
  process.exit(1);
}

for (const dir of assetDirs) {
  const entry = path.join(dir, "index.mjs");
  const module = await import(entry);
  if (typeof module.handler !== "function") {
    console.error(`handler が関数として書き出されていません: ${entry}`);
    process.exit(1);
  }
  // ui:// で配信する HTML が zip に同梱されているか（UI_HTML_PATH の指す先）
  const uiHtml = path.join(dir, "preview-view.html");
  if (!fs.existsSync(uiHtml)) {
    console.error(`ui:// の HTML が同梱されていません: ${uiHtml}`);
    process.exit(1);
  }
  console.log(`OK: ${path.basename(dir)}（handler と preview-view.html を確認）`);
}
