<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0005-gestaltung.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0005: Font, sounds, logo, Claude mark

Date: 2026-10-10 · Status: accepted (at the user's request)

- **Font:** Geist (UI) and Geist Mono (code) via `@fontsource-variable/*`, bundled locally. License: SIL OFL 1.1.
  No loading from the network (CSP only allows `'self'`).
- **Sounds:** synthesized via the Web Audio API (`src/lib/sounds.ts`), no audio files. Signals: done
  (rising third), approval needed (two short tones), error (falling third). Stopped turns do not trigger a
  sound. Can be turned off: Settings → "Play sounds" (FORGE setting `sounds`, on by default).
- **Logo:** anvil with three sparks based on the user's template, rebuilt as a vector
  (`src/assets/logo.svg`; `logo-dark.svg` with lighter metal for dark surfaces). App icons are generated with
  `pnpm tauri icon src-tauri/icons/source.svg`. If the original template is available as PNG, it can
  serve as the icon source instead.
- **Claude mark:** assistant messages show a traced Claude starburst mark in terracotta
  (`ClaudeMark.tsx`, token `--color-claude`). Note: the mark belongs to Anthropic. Unproblematic for internal
  use; check the Anthropic trademark guidelines before public distribution. The
  original master prompt wanted to avoid third-party marks; the user explicitly decided in favor of it.
- **Accent color** shifted slightly from violet to indigo (`#6e6bf7`), to match the logo.
