exec(open('../../../.i18n-scratch/rep.py', encoding='utf-8').read())
rep('components/search/SearchHits.tsx',[
('export const HIT_ROLE_LABEL: Record<SearchHit["role"], string> = { user: "Du", assistant: "Claude", tool: "Werkzeug" };','export const HIT_ROLE_LABEL: Record<SearchHit["role"], string> = { user: t.search.you, assistant: "Claude", tool: t.search.tool };'),
('{hit.role === "user" ? "Du" : hit.role === "tool" ? <Wrench className="h-3 w-3" aria-label="Werkzeug" /> : <ClaudeMark size={13} />}','{hit.role === "user" ? t.search.you : hit.role === "tool" ? <Wrench className="h-3 w-3" aria-label={t.search.tool} /> : <ClaudeMark size={13} />}'),
('{hit.sessionTitle ?? "Ohne Titel"}','{hit.sessionTitle ?? t.search.untitled}'),
],'import { t } from "@/i18n";')
addns('search','''
  you: "Du",
  tool: "Werkzeug",
  untitled: "Ohne Titel",
''','''
  you: "You",
  tool: "Tool",
  untitled: "Untitled",
''')
S='t.layout.sources.'
rep('components/layout/palette-sources.tsx',[
('label: s.title ?? "Ohne Titel",','label: s.title ?? '+S+'untitled,'),
('label: `Branch wechseln: ${b.name}`,\n          keywords: "git checkout",','label: '+S+'switchBranch(b.name),\n          keywords: "branch wechseln git checkout switch",'),
('label: `Mit Claude prüfen: ${k.title}`,\n          keywords: `veraltet verweise korrigieren ${refs.map((r) => r.ref).join(" ")}`,','label: '+S+'checkWithClaude(k.title),\n          keywords: `veraltet verweise korrigieren outdated references fix ${refs.map((r) => r.ref).join(" ")}`,'),
('label: `Als geprüft markieren: ${k.title}`,\n          keywords: "veraltet verweise fehlalarm geprüft",','label: '+S+'markChecked(k.title),\n          keywords: "veraltet verweise fehlalarm geprüft outdated references false alarm checked",'),
('hint: `MCP Server · ${m.statusText}`,','hint: '+S+'mcpServer(m.statusText),'),
('hint: s.scope === "project" ? "Eigener Skill im Projekt" : "Eigener Skill",','hint: s.scope === "project" ? '+S+'ownSkillProject : '+S+'ownSkill,'),
('hint: p.installed ? "installiert" : `Marketplace · ${p.marketplace}`,','hint: p.installed ? '+S+'installed : '+S+'marketplace(p.marketplace),'),
],'import { t } from "@/i18n";')
addns('layout','''
  sources: {
    untitled: "Ohne Titel",
    switchBranch: (branch: string) => `Branch wechseln: ${branch}`,
    checkWithClaude: (title: string) => `Mit Claude prüfen: ${title}`,
    markChecked: (title: string) => `Als geprüft markieren: ${title}`,
    mcpServer: (status: string) => `MCP Server · ${status}`,
    ownSkillProject: "Eigener Skill im Projekt",
    ownSkill: "Eigener Skill",
    installed: "installiert",
    marketplace: (name: string) => `Marketplace · ${name}`,
  },
''','''
  sources: {
    untitled: "Untitled",
    switchBranch: (branch) => `Switch branch: ${branch}`,
    checkWithClaude: (title) => `Check with Claude: ${title}`,
    markChecked: (title) => `Mark as checked: ${title}`,
    mcpServer: (status) => `MCP server · ${status}`,
    ownSkillProject: "Own skill in the project",
    ownSkill: "Own skill",
    installed: "installed",
    marketplace: (name) => `Marketplace · ${name}`,
  },
''')
A='t.app.'
rep('App.tsx',[
('<div className="text-sm font-medium">FORGE läuft nur als Desktop-App.</div>','<div className="text-sm font-medium">{'+A+'desktopOnly}</div>'),
('''          Die Oberfläche braucht den lokalen Hintergrunddienst. Starte sie mit <code className="font-mono">pnpm dev</code> im Projektordner.''','''          {'''+A+'''needsSidecar} {'''+A+'''startWith} <code className="font-mono">pnpm dev</code> {'''+A+'''inProjectFolder}'''),
('<Spinner /> FORGE startet …','<Spinner /> {'+A+'starting}'),
('<div className="text-sm font-medium">Der FORGE-Hintergrunddienst läuft nicht.</div>','<div className="text-sm font-medium">{'+A+'sidecarDown}</div>'),
('text-muted">Starte ihn im FORGE-Hauptfenster neu. Dieses Fenster verbindet sich danach von selbst.</div>','text-muted">{'+A+'restartInMain}</div>'),
('<RotateCw className="h-3.5 w-3.5" /> Neu starten','<RotateCw className="h-3.5 w-3.5" /> {'+A+'restart}'),
('<SkeletonRegion label="Lädt Ansicht"','<SkeletonRegion label={'+A+'loadingView}'),
('<SkeletonRegion label="Lädt Installationsprüfung"','<SkeletonRegion label={'+A+'loadingInstallCheck}'),
('text-muted">Voraussetzung ist Node.js ab Version 22.13 im PATH.</div>','text-muted">{'+A+'nodeRequired}</div>'),
('''        FORGE ist nicht vollständig installiert, es fehlt: {missing.join(", ")}. Installiere FORGE mit der vollständigen setup.exe von der Release-Seite, nicht mit dem Update-Zip.''','''        {'''+A+'''incomplete(missing.join(", "))}'''),
('<ExternalLink className="h-3.5 w-3.5" /> Release-Seite öffnen','<ExternalLink className="h-3.5 w-3.5" /> {'+A+'openReleases}'),
],'import { t } from "@/i18n";')
addns('app','''
  desktopOnly: "FORGE läuft nur als Desktop-App.",
  needsSidecar: "Die Oberfläche braucht den lokalen Hintergrunddienst.",
  startWith: "Starte sie mit",
  inProjectFolder: "im Projektordner.",
  starting: "FORGE startet …",
  sidecarDown: "Der FORGE-Hintergrunddienst läuft nicht.",
  restartInMain: "Starte ihn im FORGE-Hauptfenster neu. Dieses Fenster verbindet sich danach von selbst.",
  restart: "Neu starten",
  loadingView: "Lädt Ansicht",
  loadingInstallCheck: "Lädt Installationsprüfung",
  nodeRequired: "Voraussetzung ist Node.js ab Version 22.13 im PATH.",
  incomplete: (missing: string) =>
    `FORGE ist nicht vollständig installiert, es fehlt: ${missing}. Installiere FORGE mit der vollständigen setup.exe von der Release-Seite, nicht mit dem Update-Zip.`,
  openReleases: "Release-Seite öffnen",
''','''
  desktopOnly: "FORGE only runs as a desktop app.",
  needsSidecar: "The interface needs the local background service.",
  startWith: "Start it with",
  inProjectFolder: "in the project folder.",
  starting: "FORGE is starting …",
  sidecarDown: "The FORGE background service is not running.",
  restartInMain: "Restart it in the FORGE main window. This window then reconnects on its own.",
  restart: "Restart",
  loadingView: "Loading view",
  loadingInstallCheck: "Loading installation check",
  nodeRequired: "Requires Node.js 22.13 or later in the PATH.",
  incomplete: (missing) =>
    `FORGE is not completely installed, missing: ${missing}. Install FORGE with the full setup.exe from the release page, not with the update zip.`,
  openReleases: "Open release page",
''')
