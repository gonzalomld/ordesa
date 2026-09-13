# mCode Platform Rules

## Linting & Type-Checking

- Run lint/type-check **once**, only after **all** edits are complete. Never between individual file changes.
- **No doom loops**: if lint reports errors, fix the critical ones and stop. Maximum 1 cycle: lint → fix → lint. Do not keep looping.
- **Prefer oxlint**: if the project has `oxlint` in devDependencies, use `npx oxlint` instead of `eslint`. It is 100x faster.
- **Install oxlint**: if the project uses eslint but does NOT have oxlint, install it (`npm i -D oxlint`) and update the `lint` script in package.json to `oxlint` before running lint. This is a one-time migration.
- **Targeted lint**: never lint the entire project. If you edited 2 files, lint only those: `npx oxlint src/file1.tsx src/file2.tsx`
- **Skip when irrelevant**: if you only changed CSS, text content, or static assets, do not run lint. It only matters after JS/TS logic changes.

## Execution

- Never explain how to run the app locally (npm run dev, etc.). The mCode environment handles compilation and preview automatically.
