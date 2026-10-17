# Mitgelieferte Software von Drittanbietern

Der Windows-Installer von FORGE enthält folgende Programme unverändert (bis auf entfernte
Dokumentation und Übersetzungen bei Git). Die Lizenztexte liegen in der Installation unter `runtime/`.

| Software | Version | Lizenz | Quelle |
|---|---|---|---|
| Node.js | 24.21.0 | MIT (und weitere, siehe `runtime/node/LICENSE`) | https://nodejs.org |
| Git for Windows (PortableGit) | 2.56.0.2 | GPL-2.0 und weitere, siehe `runtime/git/LICENSE.txt` | https://gitforwindows.org |
| GitHub CLI | 2.102.0 | MIT (`runtime/gh/LICENSE`) | https://cli.github.com |
| Python (NuGet-Paket `python`, mit pip) | 3.14.8 | PSF License und weitere, siehe `runtime/python/LICENSE.txt` | https://www.python.org |

Quellcode von Git for Windows: https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.2
(GPL-2.0: der Quellcode der mitgelieferten Version ist dort erhältlich).

Nicht im Installer, sondern beim ersten Start einer Test-Datenbank geladen: PostgreSQL 17.10 für Windows x64
(PostgreSQL License, https://www.postgresql.org/about/licence/) aus dem npm-Paket `@embedded-postgres/windows-x64`
(MIT, https://github.com/leinelissen/embedded-postgres). Es enthält Bibliotheken wie OpenSSL, ICU, zlib und libxml2
unter ihren eigenen Lizenzen. Ablage: `%APPDATA%/forge/postgres`.

Gebündelte npm-Bibliotheken (u. a. React, Radix UI, TanStack, Zod, Claude Agent SDK) stehen mit ihren
Lizenzen im jeweiligen Paket; die Schriften Geist und Geist Mono stehen unter der SIL Open Font License 1.1.
