/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.(t|j)sx?$": ["@swc/jest", { jsc: { target: "es2022" } }],
  },
  // 合成のたびにサーバーを esbuild で束ねる（stacks/bundle.ts）ため既定より長めにする
  testTimeout: 120000,
};
