<a href="0005-gestaltung.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0005: Schrift, Töne, Logo, Claude-Marke

Datum: 2026-10-10 · Status: angenommen (auf Wunsch des Nutzers)

- **Schrift:** Geist (UI) und Geist Mono (Code) über `@fontsource-variable/*`, lokal gebündelt. Lizenz: SIL OFL 1.1.
  Kein Laden aus dem Netz (CSP erlaubt nur `'self'`).
- **Töne:** per Web Audio API synthetisiert (`src/lib/sounds.ts`), keine Audiodateien. Signale: fertig
  (aufsteigende Terz), Freigabe nötig (zwei kurze Töne), Fehler (fallende Terz). Gestoppte Turns lösen keinen
  Ton aus. Abschaltbar: Einstellungen → „Töne abspielen“ (FORGE-Einstellung `sounds`, Standard an).
- **Logo:** Amboss mit orangem Funken nach Vorlage des Nutzers (Oktober 2026), als Vektor nachgebaut:
  `src/assets/logo-mark.svg` ist die Bildmarke, `src/assets/logo.svg` das App-Icon (Marke auf dunkler Kachel
  mit orangem Leuchtrand). App-Icons erzeugt `pnpm tauri icon src/assets/logo.svg` (im Ordner `apps/desktop`).
  Die Wortmarke `src/assets/forge-logo.png` setzt die Marke vor den Schriftzug.
- **Claude-Marke:** Assistenten-Nachrichten zeigen eine nachgezeichnete Claude-Strahlenmarke in Terrakotta
  (`ClaudeMark.tsx`, Token `--color-claude`). Hinweis: Die Marke gehört Anthropic. Für den internen Gebrauch
  unproblematisch; vor einer öffentlichen Verteilung die Anthropic-Markenrichtlinien prüfen. Das
  ursprüngliche Master-Prompt wollte fremde Marken vermeiden, der Nutzer hat sich ausdrücklich dafür entschieden.
- **Akzentfarbe** leicht von Violett zu Indigo verschoben (`#6e6bf7`), passend zum Logo.
