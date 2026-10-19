---
title: "Logo und Branding-Dateien neu erzeugen (logo-mark.svg, logo.svg, Wortmarke, Icons, Banner, Screenshots)"
summary: "Wo das FORGE-Logo überall steckt und wie man alle Varianten (App-Icons, Wortmarke, Installer-Bilder, Banner, Social Preview, README-Screenshots, Website-Wortmarke, Stats-Favicons) aus den Quellen neu erzeugt."
tags: ["branding","release","installer","tauri","stolperfalle"]
updated: "2026-10-19T16:09:46.098Z"
---

Stand 2026-10-19: neues Logo nach Vorlage des Besitzers (oranger Funke oben, heller Amboss, auf dunkler Kachel mit orangem Leuchtrand). Vorlage war ein KI-Rasterbild; die Formen sind von Hand als Vektor nachgebaut.

## Quellen
- `apps/desktop/src/assets/logo-mark.svg`: nur die Bildmarke (ohne Kachel).
- `apps/desktop/src/assets/logo.svg`: App-Icon = Kachel + Leuchtrand + Marke (Pfade aus logo-mark.svg kopiert, `transform` skaliert). Beide zusammen ändern. Kopie: `services/stats/src/app/icon.svg`.
- `apps/desktop/src/assets/forge-logo.png` (945 x 223): Wortmarke = gerenderte Marke (248 px breit) + Schriftzug „FORGE / Claude Development Studio“. Der Schriftzug ist nur als Raster vorhanden (Schrift unbekannt). Gleiche Datei in `apps/installer/ui/assets/`. Seitenverhältnis 945/223 steht in `Logo.tsx` und `apps/installer/ui/index.html` (width 110 bei 26 px).
- Website: `services/stats/src/assets/forge-wordmark.png` (944 x 184) = Marke + „FORGE“ ohne Unterzeile, aus forge-logo.png zusammengesetzt (Ausschnitte siehe Eintrag zum Statistik-Dienst). Ändert sich forge-logo.png, neu erzeugen.

## Erzeugen
- Rendern geht mit sharp aus `node_modules/.pnpm/sharp@*/node_modules/sharp` (librsvg, kann feGaussianBlur). Kein PIL auf dem Rechner.
- App-Icons: in `apps/desktop` `pnpm tauri icon src/assets/logo.svg`; danach die erzeugten Ordner für Android und iOS unter `src-tauri/icons/` löschen (nicht im Repo). Der Installer (apps/installer) nutzt `../desktop/src-tauri/icons/icon.ico`.
- NSIS-Bilder: `powershell -File apps/desktop/src-tauri/installer/render.ps1` (rendert header.html/sidebar.html mit Chrome).
- Banner: `.github/assets/banner/banner.{de,en}.html` mit Chrome headless rendern: `--window-size=1280,640 --force-device-scale-factor=2 --virtual-time-budget=4000 --screenshot=...` → `banner.png` / `banner-en.png`; `social-preview.png` = deutsches Banner bei Faktor 1. Die Social Preview muss in den GitHub-Repo-Einstellungen von Hand hochgeladen werden.
- README-Screenshots (2880x1800): Logo sitzt in der Seitenleiste bei (40,40), 88 px hoch. Statt neu aufzunehmen kann man die Fläche 420x92 ab (38,38) mit `#1a1e25` (26,30,37) füllen und die Wortmarke auf 88 px Höhe darüberlegen.
- Stats-Favicons: `icon.svg` = logo.svg, `apple-icon.png` 256x256 aus logo.svg.

## Stolperfallen
- Write/Edit außerhalb des Projekts ist im Autonomous-Profil gesperrt; Hilfsdateien im Repo ablegen und danach löschen (Bash darf nach `/c/tmp/...` schreiben).
- Die Landingpage-Bilder `services/stats/src/assets/app-{de,en}.webp` (1600x1000) sind aus `.github/assets/screenshots/projekte.png` und `en/projects.png` erzeugt; nach neuen Screenshots mitziehen.
