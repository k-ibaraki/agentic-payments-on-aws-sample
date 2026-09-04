import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
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
