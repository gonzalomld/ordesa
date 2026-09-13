# AGENTS.md — ordesa-3d-trail

Scaffold, not the final architecture. The project brief (scroll-narrative 3D of Senda de los Cazadores: Vite + vanilla TS + three.js + Lenis, no UI framework, custom CSS) does **not** match what is scaffolded here (React 19 + Tailwind v4 + shadcn). Do not assume the brief stack — check what is actually installed before adding 3D/data code.

## Commands (verified in `package.json` / `vercel.json` / `vite.config.ts`)

- Install: `npm install --legacy-peer-deps` (required — see `vercel.json` `installCommand`; React 19 + peer deps break plain `npm install`).
- Dev server: `npm run dev` → Vite on `::` port `8080` (not default 5173).
- Build: `npm run build` (`vite build` only — no `tsc -b`, no typecheck step). Preview: `npm run preview`.
- Lint: `npm run lint` = `eslint .` (flat config `eslint.config.js`, ignores `dist`). No test, typecheck, or format script exists.
- Path alias: `@/*` → `./src/*` (defined in both `vite.config.ts` and `tsconfig.app.json`).

## Workflow rules (`opencode.json` → `docs/mcode-rules.md`, obey those)

- Lint/typecheck **once after all edits**, never between files. Max 1 cycle: lint → fix critical → lint. No doom loops.
- Targeted lint only: `npx oxlint <edited-files>` if available (install `oxlint` as devDep and migrate `lint` script on first use); else `npx eslint <edited-files>`. Never full-project lint.
- Skip lint for CSS/text/static-asset-only changes.
- Never explain how to run the app locally.

## Stack specifics

- Tailwind v4 (via `@tailwindcss/vite`), no `tailwind.config.js`. Theme tokens live in `@theme` inside `src/globals.css`; dark mode via `@custom-variant dark`. Import order matters: `@import "tailwindcss"` first in `globals.css`, imported once by `src/main.tsx`.
- shadcn `new-york`, base `slate`, CSS variables, icon lib `lucide` (`components.json`). Aliases: `@/components`, `@/lib`, `@/hooks`, `@/components/ui`. Class merge helper: `cn()` in `src/lib/utils.ts` (`clsx` + `tailwind-merge`).
- Routing: `react-router-dom` v7 SPA in `src/main.tsx` (`/` → `pages/Index.tsx`, `/components` → `pages/Components.tsx`, `*` → `pages/NotFound.tsx`); `App.tsx` is just `<Outlet/>`. `vercel.json` rewrites everything to `/index.html` — add routes only in `main.tsx`.
- Global providers in `main.tsx`: `QueryClientProvider` + `BrowserRouter` + `<Toaster/>` from `@/components/ui/sonner`. Keep them when editing entry.
- TS strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` (`tsconfig.app.json`). `src/` only; `vite.config.ts` covered by `tsconfig.node.json`. `@typescript-eslint/no-unused-vars` is off in eslint, but `tsc` flags still apply if ever run.
- No CI (`.github/` absent), no README, no tests. `src/pages/Components.tsx` is a scaffold gallery, not app code.
