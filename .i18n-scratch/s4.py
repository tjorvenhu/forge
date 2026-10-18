exec(open('../../../.i18n-scratch/rep.py', encoding='utf-8').read())
Y='t.layout.sync.'
rep('components/layout/SyncButton.tsx',[
('title: "Wird gerade abgeglichen"','title: '+Y+'syncing'),
('title: "Abgleich fehlgeschlagen"','title: '+Y+'failed'),
('title: "Sync-Passwort nötig"','title: '+Y+'needsPassphrase'),
('title: "Nicht bei GitHub angemeldet"','title: '+Y+'noGithub'),
('title: "Änderungen werden gleich hochgeladen"','title: '+Y+'pending'),
('title: "Noch nicht abgeglichen"','title: '+Y+'never'),
('title: "Alles aktuell"','title: '+Y+'ok'),
('aria-label={`GitHub-Synchronisierung: ${title}`}','aria-label={'+Y+'label(title)}'),
('rows.push(["Zuletzt abgeglichen",','rows.push(['+Y+'lastSync,'),
('rows.push(["Zuletzt geschrieben von",','rows.push(['+Y+'lastWrittenBy,'),
('rows.push(["Repository",','rows.push(['+Y+'repository,'),
('if (st.localOnly.length) rows.push(["Nur auf diesem PC", `${st.localOnly.length} ${st.localOnly.length === 1 ? "Eintrag" : "Einträge"}`]);','if (st.localOnly.length) rows.push(['+Y+'localOnly, '+Y+'entries(st.localOnly.length)]);'),
('if (st.available.length) rows.push(["Von anderen PCs", `${st.available.length} ${st.available.length === 1 ? "Projekt" : "Projekte"} zum Holen`]);','if (st.available.length) rows.push(['+Y+'fromOthers, '+Y+'toFetch(st.available.length)]);'),
('text-subtle">Verschlüsselt über GitHub. Klicken für die Einstellungen.</p>','text-subtle">{'+Y+'footer}</p>'),
],'import { t } from "@/i18n";')
rep('components/layout/Toaster.tsx',[
('''  const { toasts, dismiss, pause, resume } = useToasts();
''','''  const { toasts, dismiss, pause, resume } = useToasts();
  const closeLabel = t.layout.toaster.close;
'''),
('aria-label="Meldung schließen"','aria-label={closeLabel}'),
],'import { t } from "@/i18n";')
rep('components/layout/TokenRate.tsx',[
('title="Ausgegebene Tokens pro Sekunde, über alle Sessions, Subagenten, Agenten und das Telefon"','title={t.layout.tokenRate.title}'),
('<span className="text-muted">Ausgabe</span>','<span className="text-muted">{t.layout.tokenRate.output}</span>'),
('{perSecond.toLocaleString("de-DE")} Token/s</span>','{t.layout.tokenRate.perSecond(perSecond.toLocaleString(locale))}</span>'),
('''        const t = setTimeout(frame, REDUCED_TICK_MS);
        cancel = () => clearTimeout(t);''','''        const timer = setTimeout(frame, REDUCED_TICK_MS);
        cancel = () => clearTimeout(timer);'''),
('''    const t = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(t);''','''    const timer = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);'''),
],'import { locale, t } from "@/i18n";')
addns('layout',r'''
  sync: {
    syncing: "Wird gerade abgeglichen",
    failed: "Abgleich fehlgeschlagen",
    needsPassphrase: "Sync-Passwort nötig",
    noGithub: "Nicht bei GitHub angemeldet",
    pending: "Änderungen werden gleich hochgeladen",
    never: "Noch nicht abgeglichen",
    ok: "Alles aktuell",
    label: (title: string) => `GitHub-Synchronisierung: ${title}`,
    lastSync: "Zuletzt abgeglichen",
    lastWrittenBy: "Zuletzt geschrieben von",
    repository: "Repository",
    localOnly: "Nur auf diesem PC",
    entries: (n: number) => `${n} ${n === 1 ? "Eintrag" : "Einträge"}`,
    fromOthers: "Von anderen PCs",
    toFetch: (n: number) => `${n} ${n === 1 ? "Projekt" : "Projekte"} zum Holen`,
    footer: "Verschlüsselt über GitHub. Klicken für die Einstellungen.",
  },
  toaster: {
    close: "Meldung schließen",
  },
  tokenRate: {
    title: "Ausgegebene Tokens pro Sekunde, über alle Sessions, Subagenten, Agenten und das Telefon",
    output: "Ausgabe",
    perSecond: (n: string) => `${n} Token/s`,
  },
''',r'''
  sync: {
    syncing: "Syncing now",
    failed: "Sync failed",
    needsPassphrase: "Sync password needed",
    noGithub: "Not signed in to GitHub",
    pending: "Changes will be uploaded shortly",
    never: "Not synced yet",
    ok: "All up to date",
    label: (title) => `GitHub sync: ${title}`,
    lastSync: "Last synced",
    lastWrittenBy: "Last written by",
    repository: "Repository",
    localOnly: "Only on this PC",
    entries: (n) => `${n} ${n === 1 ? "entry" : "entries"}`,
    fromOthers: "From other PCs",
    toFetch: (n) => `${n} ${n === 1 ? "project" : "projects"} to fetch`,
    footer: "Encrypted via GitHub. Click for settings.",
  },
  toaster: {
    close: "Close message",
  },
  tokenRate: {
    title: "Output tokens per second, across all sessions, subagents, agents and the phone",
    output: "Output",
    perSecond: (n) => `${n} tokens/s`,
  },
''')
