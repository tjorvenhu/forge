<a href="0005-gestaltung.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0005: Schrift, Töne, Logo, Claude-Marke

Datum: 2026-10-10 · Status: angenommen (auf Wunsch des Nutzers)

- **Schrift:** Geist (UI) und Geist Mono (Code) über `@fontsource-variable/*`, lokal gebündelt. Lizenz: SIL OFL 1.1.
  Kein Laden aus dem Netz (CSP erlaubt nur `'self'`).
- **Töne:** per Web Audio API synthetisiert (`src/lib/sounds.ts`), keine Audiodateien. Signale: fertig
  (aufsteigende Terz), Freigabe nötig (zwei kurze Töne), Fehler (fallende Terz). Gestoppte Turns lösen keinen
  Ton aus. Abschaltbar: Einstellungen → „Töne abspielen“ (FORGE-Einstellung `sounds`, Standard an).
- **Logo:** Amboss mit drei Funken nach Vorlage des Nutzers, als Vektor nachgebaut
  (`src/assets/logo.svg`; `logo-dark.svg` mit hellerem Metall für dunkle Flächen). App-Icons werden mit
  `pnpm tauri icon src-tauri/icons/source.svg` erzeugt. Liegt die Originalvorlage als PNG vor, kann sie
  stattdessen als Icon-Quelle dienen.
- **Claude-Marke:** Assistenten-Nachrichten zeigen eine nachgezeichnete Claude-Strahlenmarke in Terrakotta
  (`ClaudeMark.tsx`, Token `--color-claude`). Hinweis: Die Marke gehört Anthropic. Für den internen Gebrauch
  unproblematisch; vor einer öffentlichen Verteilung die Anthropic-Markenrichtlinien prüfen. Das
  ursprüngliche Master-Prompt wollte fremde Marken vermeiden, der Nutzer hat sich ausdrücklich dafür entschieden.
- **Akzentfarbe** leicht von Violett zu Indigo verschoben (`#6e6bf7`), passend zum Logo.
