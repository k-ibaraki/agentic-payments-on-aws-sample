// サーバーを Web Functions の zip の形に束ねる（DESIGN.md 決定74）。
//
// Web Functions の実行環境は zip の根の index.js を起動する。NodejsFunction のような
// 束ね役が無いので、esbuild をここから直接呼び、ui:// で配る HTML と
// 「index.js は ESM」と伝える package.json を同じ場所に置く
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

/**
 * ESM 出力に require / __filename / __dirname を用意するバナー。
 * CJS 配布のまま動的 require を使う依存（AWS SDK v3 等）を同梱するために要る
 */
const BUNDLE_BANNER = [
  "import { createRequire as topLevelCreateRequire } from 'module';",
  "const require = topLevelCreateRequire(import.meta.url);",
  "import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from 'url';",
  "const __filename = topLevelFileUrlToPath(import.meta.url);",
  "const __dirname = topLevelFileUrlToPath(new topLevelURL('.', import.meta.url));",
].join("\n");

/** ui:// で配信する HTML（vite singlefile の出力）の、リポジトリ内での場所 */
export const UI_HTML_RELATIVE_PATH = "server/dist/ui/src/ui/preview-view.html";

/**
 * 束ねた結果の置き場。固定の場所にするのは、source map が書く相対パスを毎回同じにして、
 * 中身が変わらないかぎりアセットのハッシュ（＝revision の作り直し）が変わらないようにするため
 */
const BUNDLE_RELATIVE_DIR = "server/dist/bundle";

/** zip に入れる HTML のファイル名。環境変数 UI_HTML_PATH がこれを指す */
export const UI_HTML_BUNDLED_NAME = "preview-view.html";

/**
 * サーバーを束ね、zip の中身になるディレクトリの場所を返す。
 * 先に `server` で `pnpm build:ui` が済んでいる必要がある
 */
export function bundleServer(projectRoot: string): string {
  const uiHtmlPath = path.join(projectRoot, UI_HTML_RELATIVE_PATH);
  if (!fs.existsSync(uiHtmlPath)) {
    throw new Error(
      `ui:// で配信する HTML が見つかりません: ${uiHtmlPath}\n` +
        "先に billing-mcp/server で pnpm build:ui を実行してください",
    );
  }

  const outDir = path.join(projectRoot, BUNDLE_RELATIVE_DIR);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  esbuild.buildSync({
    entryPoints: [path.join(projectRoot, "server/src/index.ts")],
    outfile: path.join(outDir, "index.js"),
    bundle: true,
    platform: "node",
    // server の package.json は type: module。import.meta を使うため ESM で出す
    format: "esm",
    target: "node24",
    // Web Functions の実行環境には AWS SDK が同梱されていない。依存は全て束ねる
    // （再現性のためにも、合成した成果物をそのまま手元で動かせるためにも、外に出さない）
    banner: { js: BUNDLE_BANNER },
    sourcemap: true,
    absWorkingDir: path.join(projectRoot, "server"),
    logLevel: "warning",
  });

  fs.copyFileSync(uiHtmlPath, path.join(outDir, UI_HTML_BUNDLED_NAME));
  // 実行環境は index.js を読む。拡張子で ESM と伝えられないので package.json で伝える
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
  return outDir;
}
