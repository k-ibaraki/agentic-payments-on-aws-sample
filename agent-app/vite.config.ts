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
    // 対象は手で書いたテストの置き場だけに絞る。書き出し先（tsc の build-temp/、合成の .amplify/ と cdk.out/。
    // AgentCore Runtime の資産は依存のテストファイルまで束ねる。決定72）を 1 つずつ除外する形だと、書き出し先が
    // 増えるたびに拾ってしまう。test/ の e2e は node:test で別に走らせる（npm run test:e2e）
    include: ['{aws-blocks,src,amplify,scripts}/**/*.test.ts'],
    exclude: configDefaults.exclude
  }
});
