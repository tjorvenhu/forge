<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0005-gestaltung.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0005: Font, sounds, logo, Claude mark

Date: 2026-10-10 · Status: accepted (at the user's request)

- **Font:** Geist (UI) and Geist Mono (code) via `@fontsource-variable/*`, bundled locally. License: SIL OFL 1.1.
  No loading from the network (CSP only allows `'self'`).
- **Sounds:** synthesized via the Web Audio API (`src/lib/sounds.ts`), no audio files. Signals: done
  (rising third), approval needed (two short tones), error (falling third). Stopped turns do not trigger a
  sound. Can be turned off: Settings → "Play sounds" (FORGE setting `sounds`, on by default).
- **Logo:** anvil with an orange spark based on the user's template (October 2026), rebuilt as a vector:
  `src/assets/logo-mark.svg` is the mark, `src/assets/logo.svg` the app icon (mark on a dark tile with an
  orange glowing rim). App icons are generated with `pnpm tauri icon src/assets/logo.svg` (in `apps/desktop`).
  The wordmark `src/assets/forge-logo.png` puts the mark in front of the lettering.
- **Claude mark:** assistant messages show a traced Claude starburst mark in terracotta
  (`ClaudeMark.tsx`, token `--color-claude`). Note: the mark belongs to Anthropic. Unproblematic for internal
  use; check the Anthropic trademark guidelines before public distribution. The
  original master prompt wanted to avoid third-party marks; the user explicitly decided in favor of it.
- **Accent color** shifted slightly from violet to indigo (`#6e6bf7`), to match the logo.
