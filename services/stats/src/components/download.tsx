"use client";

import { useState } from "react";
import { Apple, Check, Copy, Download, ExternalLink, Monitor, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DOWNLOAD_URL, INSTALL_COMMAND, INSTALL_SCRIPT_URL } from "@/lib/constants";
import type { Builds, Os } from "@/lib/builds";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/messages";

const TABS: { os: Os; icon: LucideIcon }[] = [
  { os: "windows", icon: Monitor },
  { os: "macos", icon: Apple },
  { os: "linux", icon: Terminal },
];

function CopyCommand({ locale }: { locale: Locale }) {
  const d = i18n(locale).t.download;
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  return (
    <div className="install-command">
      <code>{INSTALL_COMMAND}</code>
      <button type="button" className="btn btn-outline" onClick={copy} aria-label={copied ? d.copied : d.copy}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className="install-copy-label">{copied ? d.copied : d.copy}</span>
      </button>
    </div>
  );
}

/** One system: Windows gets the setup, macOS and Linux the install command and the files of the newest release. */
function Panel({ locale, os, builds }: { locale: Locale; os: Os; builds: Builds | null }) {
  const d = i18n(locale).t.download;
  if (os === "windows") {
    return (
      <>
        <p>{d.windowsText}</p>
        <a className="btn btn-primary btn-lg" href={DOWNLOAD_URL}>
          <Download aria-hidden />
          {d.windowsButton}
        </a>
        <p className="download-note">{d.windowsNote}</p>
      </>
    );
  }
  const build = builds?.[os];
  if (builds && !build) return <p className="download-soon">{d.soon}</p>;
  return (
    <>
      <p>{d.commandIntro}</p>
      <CopyCommand locale={locale} />
      <p>{os === "macos" ? d.macosText : d.linuxText}</p>
      <p className="download-note">
        {os === "macos" ? d.macosNote : d.linuxNote}{" "}
        <a href={INSTALL_SCRIPT_URL}>
          {d.script}
          <ExternalLink aria-hidden className="download-external" />
        </a>
      </p>
      {build ? (
        <div className="download-manual">
          <span>{d.manual(build.version)}</span>
          <ul>
            {build.files.map((f) => (
              <li key={f.url}>
                <a href={f.url}>
                  <Download aria-hidden />
                  {f.label}
                </a>
              </li>
            ))}
          </ul>
          {os === "macos" && <p className="download-note">{d.manualMacNote}</p>}
        </div>
      ) : (
        <p className="download-note">{d.unknown}</p>
      )}
    </>
  );
}

export function DownloadPage({ locale, os, phone, builds }: { locale: Locale; os: Os; phone: boolean; builds: Builds | null }) {
  const d = i18n(locale).t.download;
  const [tab, setTab] = useState<Os>(os);
  return (
    <main className="container download-page">
      <h1>{d.title}</h1>
      <p className="download-lead">{d.lead}</p>
      {phone && <p className="download-soon">{d.phone}</p>}
      <div className="download-card">
        <div className="download-tabs" role="tablist" aria-label={d.tabs}>
          {TABS.map(({ os: o, icon: Icon }) => (
            <button key={o} type="button" role="tab" id={`tab-${o}`} aria-selected={tab === o} aria-controls="download-panel" onClick={() => setTab(o)}>
              <Icon aria-hidden />
              {d[o]}
            </button>
          ))}
        </div>
        <div className="download-panel" id="download-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <Panel locale={locale} os={tab} builds={builds} />
        </div>
      </div>
    </main>
  );
}
