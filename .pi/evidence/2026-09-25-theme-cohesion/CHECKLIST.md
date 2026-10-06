# Theme cohesion: owner sign-off

Run against your own `task dev` session. Tick each line when observed.

Vitest totals from Task 9: 1 failed | 388 passed (389 tests), 1 failed | 42 passed (43 test files)

**Note on Task 9 Steps 1-2 vs the plan's Expected lines:** the plan expected `npx vitest run` all
green and `npx tsc --noEmit -p tsconfig.json` clean. Neither held, but nothing found traces to this
arc's own diff (`git diff daily-driver/combined-2026-09-21..HEAD` touches none of the files below):

- `frontend/app/onboarding/onboarding-command.test.tsx` fails comparing
  `public/logos/remoteterm-logo.png` (1563×1563) against `public/logos/wave-logo.png` (1024×1024) —
  a pre-existing size mismatch from commit `425180d8` ("fix(onboarding): logo demo shows the
  RemoteTerm logo, not Wave art"), already present at the `daily-driver/combined-2026-09-21` branch
  point, unrelated to appearance mode.
- `tsc` reports pre-existing errors in `frontend/app/view/term/term.tsx:321` (`overviewRuler`, in
  code this arc's diff does not touch — the diff only touches the import list and the
  `computeTheme` call at 278-287), `frontend/preview/mock/defaultconfig.ts`,
  `frontend/preview/mock/preview-electron-api.ts`, and 14 instances in
  `frontend/preview/previews/processviewer.preview.tsx` (`ProcessInfo.numthreads`), all in files
  this arc never edits — mock/preview code stale relative to types changed elsewhere.

Both are flagged here rather than fixed; fixing them is outside this plan's task list.

## Global light (`window:appearancemode: light`, no tab override)
- [ ] Terminal with no `term:theme`: dark text on white, ANSI colours legible (`ls --color`, the printf line from Task 8).
- [ ] Code editor block: light Monaco theme (vs base), transparent editor background over the app background.
- [ ] Linux/Windows only: window-control symbols are dark on the light titlebar.
- [ ] Terminal with `term:theme` set to Dracula (right-click > Themes): stays Dracula.

## Tab override dark (right-click tab > Appearance > Dark, global still light)
- [ ] Terminal, editor and symbols in that tab flip to dark without reload; other tabs stay light.
- [ ] Setting the tab back to Default restores light.

## Global dark
- [ ] Everything as before this arc: `default-dark` terminal, dark Monaco, light symbols.

## OS flip (global `system`)
- [ ] Toggle the desktop light/dark setting with the app open: all three surfaces follow.

## Palette review
- [ ] `default-light` colours acceptable as rendered. Adjustments go in `pkg/rtconfig/defaultconfig/termthemes.json`; `termthemes-contrast.test.ts` enforces 4.5:1.
- [x] Task 8 evidence flagged the terminal's light-mode background as sampling `rgb(127,127,127)`
      rather than white. Rechecked 2026-09-26 (see README's "2026-09-26 recheck" section): does not
      reproduce — two independent capture methods (CDP + native X11), multiple sample points, both
      light and dark, all match the expected tokens. No fix needed; treat the original reading as a
      measurement artifact.
