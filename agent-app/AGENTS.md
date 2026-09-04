# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **AWS Blocks docs** ship inside the `@aws-blocks/blocks` package. Find the docs folder once: `node -p "require('path').dirname(require.resolve('@aws-blocks/blocks/docs/README.md'))"` (fallback: `node_modules/@aws-blocks/blocks/docs`). Read everything relative to it: `README.md` (dev guide + catalog + decision tree — start here), then `<block>/README.md`, plus `<block>/API.md` and `<block>/DESIGN.md` where present.

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration: run `npm run dev &` in the background, then run `npm run test:e2e` repeatedly (reuses the running server)
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **Read block docs** before using a block — start with its `README.md`, then `API.md` / `DESIGN.md` where present — not every block has them, so a missing file is not an error (see the **AWS Blocks docs** bullet above for where the docs folder lives).
- **The JSON-RPC transport is invisible** — do not construct RPC payloads manually. Import and call the typed API directly.

## Deploying (requires AWS credentials)

The primary cloud path is **Amplify Gen2 + Amplify Hosting** (see `README.md` and `docs/DESIGN.md` decision 33). The CDK-only path below is kept as a fallback.

- `npm run amplify:sandbox -- --once` — deploy the Amplify sandbox (Blocks as a nested stack); `npm run amplify:sandbox:delete` — tear it down
- `npm run build:amplify` — frontend build for Amplify Hosting (called by `amplify.yml`; needs `amplify_outputs.json`)
- `BLOCKS_API_URL=$(node -p "require('./amplify_outputs.json').custom.blocks_api_url") npm run dev` — point the local frontend at the Amplify sandbox API

CDK-only fallback:

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources
