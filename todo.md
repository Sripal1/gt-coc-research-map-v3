# AI Map Code Review - TODO

## Project Overview
AI Map is a Svelte-based interactive visualization tool for Georgia Tech College of Computing researchers. It uses UMAP embeddings to position researchers on a 2D map, with features including semantic/lexical search (via HuggingFace Transformers.js + FlexSearch), contour overlays, time-based filtering, force-simulated point layout, and WebGL/SVG rendering with D3.js.

---

## High Priority

### 1. Outdated Dependencies
- **Svelte 3.52** → Svelte 5 (current)
- **Vite 3.2** → Vite 6
- **TypeScript 4.6** → TypeScript 5.x
- **d3 modules** are old patch versions across the board

### ~~2. Bogus Dependencies in `package.json`~~ ✅
- ~~`"from": "^0.1.7"` and `"import": "^0.0.6"` are not real libraries — likely copy-paste artifacts. Should be removed.~~

### ~~3. D3 Modules in Wrong Section~~ ✅
- ~~All `d3-*` packages are in `devDependencies` but are used at runtime.~~ Runtime `d3-*` packages are now in `dependencies`; only `@types/d3-*` remain in `devDependencies` (correct).

### ~~4. Debug Mode Left On~~ ✅
- ~~`src/config/config.ts` has `debug: true`. Should be `false` or driven by `import.meta.env`.~~ Now uses `import.meta.env.DEV`.

### ~~5. Console Logging in Production~~ ✅
- ~~`workers/loader.ts` logs `console.log('Processing point:', loadedPointCount)` on **every single point** during data loading — heavy performance hit.~~ Removed.

### ~~6. XSS Vulnerability~~ ✅
- ~~`Embedding.svelte` uses `{@html currentPoint?.currSummary}` without sanitization.~~ Now uses `DOMPurify.sanitize()`.

### ~~7. O(n) Hover Detection~~ ✅
- ~~`Embedding.ts` → `mouseoverPoint()` iterates all points on every mouse move.~~ Now uses local `pointQuadtree` for O(log n) nearest-neighbor lookup.

### ~~8. Image Reloading on Every Zoom~~ ✅
- ~~`EmbeddingPointWebGL.ts` creates a `new Image()` for every point on every zoom event.~~ Now uses `imageAspectRatioCache` to avoid reloading.

---

## Medium Priority

### ~~9. Duplicated Helper Functions~~ ✅
- ~~`anyTrue()` and `allTrue()` copy-pasted in 5 files.~~ Extracted to `utils/utils.ts` and imported everywhere.

### ~~10. Typo in Variable Name~~ ✅
- ~~`lsatRefillTime`~~ Renamed to `lastRefillTime`.

### ~~11. Wrong TypeScript Type~~ ✅
- ~~`labelSummariesVisible: Boolean | null`~~ Changed to `boolean | null`.

### ~~12. Broken SCSS in Inline Styles~~ ✅
- ~~`Embedding.svelte` uses `style="color: $blue-500;"` — SCSS variables don't work in inline styles.~~ Fixed.

### ~~13. Memory Leak: Uncleared Interval~~ ✅
- ~~`startPlaceholderRotation()` creates a `setInterval` that is never cleared.~~ Added `stopPlaceholderRotation()`, called in `cleanup()`.

### ~~14. Store Subscription Leaks~~ ✅
- ~~Store subscriptions never unsubscribed.~~ All 3 subscriptions now stored and unsubscribed in `cleanup()`.

### ~~15. No Search Debouncing~~ ✅
- ~~`SearchPanel.ts` fires a search on every keystroke.~~ Added 250ms debounce; empty query cancels immediately.

---

## Lower Priority

### ~~16. Dead Code / Unused Components~~ ✅
- ~~`src/components/PhrasePack/` — unused~~ Deleted.
- ~~`src/components/ResearchInterestsSelect/` — unused~~ Deleted.
- ~~`src/components/chat-panel/` — disabled chat feature~~ Deleted, along with `src/stores/` directory and all chat wiring in SearchPanel/MapView.
- ~~`src/components/diffusiondbvis/` — unused~~ Deleted.
- ~~`src/components/packing/` — unused~~ Deleted, along with `src/types/packing-types.ts`.
- ~~Commented-out imports in `App.svelte`, `Embedding.svelte`, `MapView.svelte`~~ Cleaned up.

### 17. Monolithic Files
- `Embedding.ts` is ~2500 lines. Could be broken into smaller modules (zoom logic, data loading, point management, store management).
- `EmbeddingLabel.ts` is ~1335 lines.

### ~~18. Duplicated SCSS~~ ✅
- ~~`MapView.scss` and `Embedding.scss` share patterns that could be extracted into shared partials.~~ Investigation found no real duplication — `.popper-tooltip` only exists in `MapView.scss`; repeated `.hidden` patterns are context-specific. No action needed.

### ~~19. Missing Error States~~ ✅
- ~~No user-facing error handling for failed data loads, broken worker initialization, or network failures.~~ Replaced hard `throw Error()` calls with `console.warn`/`console.error` + early returns. Added `onerror` handlers to all 3 web workers.

### ~~20. Unused Writable Exports~~ ✅
- ~~`Footer.ts` exports `currResearcherSummary`, `currSearchRes`, `matchExists` — these appear unused outside the file.~~ Removed all 3 writable exports and cleaned up the `writable` import.

---

## Deployment Notes

All completed items were merged into `main` via the `tool-optimizations` branch using `git merge --no-ff`.

**Merge commit:** `bd971d5`
**Branch:** `tool-optimizations`
**Deployed to GitHub Pages:** 2026-02-18

### To revert if regressions occur:
```bash
git revert -m 1 bd971d5
git push origin main
pnpm run deploy:prod
```

### Commits in `tool-optimizations`:
1. `09499cc` — Delete unused components, stores, and types
2. `88c8051` — Remove dead code references to chat panel and unused imports
3. `0319bfd` — Move runtime deps to dependencies, remove bogus packages
4. `57d128b` — Extract anyTrue/allTrue into shared utils
5. `dae3456` — Drive debug flag from import.meta.env.DEV
6. `65146dd` — Remove per-point console.log spam in data loader
7. `ca46928` — Remove unused writable exports from Footer
8. `691763e` — Add 100ms search input debouncing
9. `fa140b3` — Sanitize researcher HTML, fix inline SCSS styles and image paths
10. `1b99f78` — Import shared anyTrue/allTrue utils, fix Boolean type to boolean
11. `2be1f7f` — Perf and reliability improvements to Embedding.ts

---

## File Reference

| File | Lines | Key Issues |
|------|-------|------------|
| `package.json` | - | Bogus deps, outdated versions, wrong dep section |
| `src/config/config.ts` | ~50 | `debug: true` |
| `src/components/embedding/Embedding.svelte` | ~687 | XSS, broken SCSS inline style |
| `src/components/embedding/Embedding.ts` | ~2500 | Typo, wrong type, O(n) hover, memory leak, monolithic |
| `src/components/embedding/EmbeddingPointWebGL.ts` | ~752 | Image reload on zoom, duplicated helpers |
| `src/components/embedding/EmbeddingLabel.ts` | ~1335 | Duplicated helpers, monolithic |
| `src/components/embedding/EmbeddingControl.ts` | ~335 | Duplicated helpers |
| `src/components/embedding/workers/loader.ts` | - | Console spam |
| `src/components/search-panel/SearchPanel.ts` | - | No debounce |
| `src/utils/ForceSimulation.ts` | ~145 | Safari-optimized, generally clean |
