# Theme cohesion: Task 8 evidence

Captured under nested Xvfb `:99` (isolation confirmed in `isolation.txt`: `DISPLAY=:99`,
`XDG_CONFIG_HOME=/tmp/claude-1000/theme-cohesion-xvfb/config`), scratch config/data homes,
`window:appearancemode: light` seeded before first launch. Pixel colours below were sampled
directly from the PNGs with ImageMagick (`convert file.png -format "%[pixel:p{x,y}]" info:`)
at coordinates clear of text/icons, not eyeballed.

One deviation from the plan mechanics, not the app: `pgrep -f "electron.*remoteterm-theme-cohesion"`
never matches, because this worktree's Electron binary resolves to
`remoteterm-daily/node_modules/electron/dist/electron` (shared/hoisted binary; harmless — it is
still a distinct process, launched with `DISPLAY=:99` and scratch `XDG_CONFIG_HOME`/`XDG_DATA_HOME`,
confirmed via `/proc/<pid>/environ`). The window's owning PID was located instead via
`xdotool getwindowpid` once the "RemoteTerm" window appeared. First launch also shows a one-time
"Welcome to RemoteTerm" dialog and a 4-step feature tour (fresh scratch profile); both were
dismissed by click before capturing.

## 01-global-light-terminal.png

Terminal block, `window:appearancemode: light`, no `term:theme` set. `ls --color` and the ANSI
`red green yellow blue magenta cyan` line are both legible. Sampled colours:
- Terminal background (blank area): `rgb(127,127,127)` — a mid-grey, **not** white/`#ffffff`.
- Foreground text renders in the expected dark/muted tones against that grey.

This does not match the `default-light` palette's `"background": "#ffffff"` at face value; the
terminal block also has a non-zero `termTransparency`, which alpha-blends the theme colour over
the app background rather than painting it flat, and the app background here is not white. Flagged
for the owner's Palette review line in `CHECKLIST.md` — not something Task 8 diagnoses further.

## 02-global-light-editor.png

Monaco editor block (`wsh view .../monaco-theme.ts`), same session. Editor background at a blank
area away from the gutter: `rgb(255,255,255)` — true white. Syntax highlighting uses dark text on
that white background, consistent with `wave-theme-light`.

## 03-global-light-titlebar.png

Titlebar strip. Background: `rgb(240,240,240)` (near-white). Window-control glyphs
(minimize/maximize/close, top right) render dark against it.

## 04-taboverride-dark-terminal-editor.png

Same tab, after `wsh setmeta -b tab tab:appearancemode=dark` (terminal echoes `metadata set`;
global setting is still light). Sampled colours:
- Terminal background: `rgb(17,17,17)` — near-black, changed from the light-mode `127,127,127`.
- Monaco editor background: `rgb(17,17,17)` — also switched to near-black from white, live,
  without a reload, confirming `useMonacoAppearanceTheme`'s re-`setTheme` call fires on the
  tab-level override.

## 05-taboverride-dark-titlebar.png

Titlebar under the tab override. Background: `rgb(22,22,22)` (near-black), down from `240,240,240`
in the light shot — the titlebar overlay re-sample (Task 6) fired for this change too.

## 06-global-dark-terminal-editor.png

After clearing the tab override (`tab:appearancemode=null`) and then
`wsh setconfig window:appearancemode=dark` (terminal echoes `config set`). Terminal background
`rgb(17,17,17)`, editor background `rgb(17,17,17)` — both dark, matching the tab-override shot;
this is the global-dark path rather than the per-tab path reaching the same visual state.

## 07-global-dark-titlebar.png

Titlebar under global dark. Background `rgb(22,22,22)`, matching the tab-override titlebar shot.

## Summary of what the mechanism does, as observed

- Monaco editor and the titlebar overlay both demonstrably repaint live between light and dark —
  white↔near-black for the editor, near-white↔near-black for the titlebar — for both the tab-level
  override and the global `setconfig` path, with no reload.
- The terminal panel also darkens between the light and dark captures (`127,127,127` →
  `17,17,17`), so it is responding to the same mode change, but its "light" value is a mid-grey
  rather than the palette's literal `#ffffff`, most likely from `termTransparency` blending over a
  non-white app background. This is the one item that needs the owner's eyes in Task 9's Palette
  review line, not a script-detectable pass/fail.
- Command execution was confirmed via the terminal's own echoed `metadata set` / `config set`
  output, not just by screenshot timing.

## 2026-09-26 recheck: `127,127,127` does not reproduce

Re-ran the light-mode terminal capture at the same commit (`411a27fa`) under a fresh nested Xvfb
(`:98`, isolation confirmed via `/proc/<pid>/environ` on every launched process — see the a11y-auditor's
report to the team lead for the full check), scratch `XDG_CONFIG_HOME`/`XDG_DATA_HOME` at
`/tmp/rt-theme-98` (shortened from the original evidence's path to stay under the Unix-socket
108-byte path limit — the deep `.pi/evidence`-style scratch path made `remotetermsrv` fail to bind
its socket and exit).

Traced the colour-token chain first: `.block-frame-default-inner` gets an inline
`background: rgba(255,255,255,0.5)` (from `term-model.ts`'s `blockBg` atom via
`termutil.ts:computeTheme`, `term:transparency` defaulting to `0.5`); `getComputedStyle` on every
other ancestor from `.xterm` up to `<html>` reported `rgba(0, 0, 0, 0)` (fully transparent) except
`<body>`, which resolved to solid white (`color(srgb 1 1 1)`, i.e. `--main-bg-color: rgb(255,255,255)`
under `:root[data-theme="light"]`, `--window-opacity: 1`). Blending 50%-alpha white over opaque
white is white at any alpha — mathematically there is no token-chain path in the current code that
reaches `127,127,127`.

Sampled the live pixel two ways to rule out a rendering-pipeline artifact (the run's console logged
`WebGL2 blocklisted`, worth checking before trusting any single capture method in a software-GL
Xvfb session):
- CDP `Page.captureScreenshot` (renderer-level, bypasses native window compositing):
  `srgb(255,255,255)` at the sampled point.
- Native X11 `import -window <id>` (same tool the original evidence used), three points in the
  terminal's blank area: `srgb(255,255,255)` at all three.
- Toggled to `window:appearancemode: dark` and re-captured: `srgb(17,17,17)`, matching the original
  evidence's dark-mode reading exactly, confirming the capture pipeline and the mode-toggle plumbing
  are both live, not stale. Toggled back to light: `srgb(255,255,255)` again.

`emain/emain-window.ts` sets the native `BrowserWindow`'s `backgroundColor: "#222222"` unconditionally
on Linux when `window:transparent` is off (the default here) — that's a plausible-looking dark
constant, but it only paints before first content paint or behind truly transparent CSS regions
(`winOpts.transparent` is never set to `true` in this path), and the sampled pixels rule it out as a
factor here.

**Verdict: not reproducible, no fix applied.** The original `127,127,127` reading in
`01-global-light-terminal.png` was most likely a measurement artifact (wrong sample coordinate,
or a transitional/partial frame caught mid-repaint) rather than a real background-colour bug.
Screenshots: `08-recheck-light-terminal-white.png`, `09-recheck-dark-terminal.png` (X11-level
captures, this session). `CHECKLIST.md`'s Palette review line can be marked resolved on this point.
