// 04-build-texture.ts — RETIRED in phase 2 (D1).
//
// Texture levels are now built by 13-build-terrain-assets.ts:
//   terrain-base / terrain-base-2048 / terrain-corridor /
//   terrain-corridor-4k / terrain-normal / clouds-atlas (all content-hashed,
//   names + byte sizes recorded in data/build/meta.json).
// The old terrain-2k/terrain-8k pair and its 8192 px throw are gone: the
// base never exceeds 4096 px so maxTextureSize=4096 phones stay working.
// This stub fails loudly so no stale `npm run data` step silently revives it.
throw new Error(
  "04-build-texture.ts retired: run 13-build-terrain-assets.ts instead",
);
