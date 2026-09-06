import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // 既定の 'spa' は未知のパスを index.html にフォールバックし、どんな URL でもアプリが 200 で返る。
  // この画面はクライアントルーティングを使わないので 'mpa' にして、開発サーバー・preview とも
  // 存在しないパスは 404 にする（クラウドの Amplify Hosting と揃える。決定45）
  appType: 'mpa',
  resolve: {
    conditions: ['browser']
  },
  build: {
    outDir: 'dist'
  },
  test: {
    // npm run build の tsc が build-temp/ に吐く *.test.js を拾わない（同じテストが二重に走り、
    // 古いコピーで結果が食い違う）
    exclude: [...configDefaults.exclude, 'build-temp/**']
  }
});
