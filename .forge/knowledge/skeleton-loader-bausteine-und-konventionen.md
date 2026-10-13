---
title: "Skeleton-Loader: Bausteine und Konventionen"
summary: "Welche Skeleton-Bausteine es in der Desktop-UI gibt und welche Regeln für Ladezustände gelten (Labels, Leer- vs. Ladezustand, keine Spinner in Inhaltsbereichen)."
tags: ["ui","skeleton","laden","konvention"]
updated: "2026-10-13T12:45:53.470Z"
---

Projektregel: Alles mit Ladezeit zeigt ein Skeleton in der Form des späteren Inhalts, keinen Spinner und keinen Text wie „Lädt …“.

**Bausteine** in `apps/desktop/src/components/ui/skeleton.tsx`: `Skeleton` (Block mit `animate-shimmer`), `SkeletonRegion` (Hülle mit `role="status"`), `ListSkeleton`, `TextSkeleton`, `CardSkeleton`/`CardGridSkeleton` (`min` = Mindestbreite des echten Grids), `TableSkeleton` (zeigt die echte Kopfzeile), `FormSkeleton`/`FormRowsSkeleton` (Settings-Group-Form), `CodeSkeleton`, `EditorSkeleton` (Höhe per className, z. B. `h-105`), `KeyValueSkeleton`, `ChatSkeleton`, `ComposerSkeleton`, `ChatColumnSkeleton`. Weitere: `CodeViewSkeleton` (code-view.tsx, mit h-6-Statusleiste) und `ChatPanelSkeleton` (ChatPanel.tsx). Passt keine Form, lokal aus `Skeleton` bauen (so etwa in HomeView, SessionsView, AgentsTab, DevToolsTab).

**Konventionen**
- Jede Ladefläche hat `role="status"` und ein `aria-label` der Form „Lädt X“ (z. B. „Lädt Sessions“), damit Tests und Screenreader sie finden.
- Laden und leer unterscheiden: Leerzustände („Noch keine …“, „Aus“, „gestoppt“) und `return null` erst zeigen, wenn die Query nicht mehr `isPending`/`isLoading` ist.
- Auf `bg-surface-2`-Flächen (Menüs, Statusleisten) Skeletons mit `bg-surface-3`, sonst sind sie unsichtbar.
- Spinner bleiben nur auf Knöpfen während einer Mutation und bei drehenden Refresh-Icons.
- `Loading` in `components/ui/misc.tsx` ist veraltet. Stand 2026-10 nutzt nur noch `TaskThread.tsx` es; danach kann es weg.
