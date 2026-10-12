import { RotateCcw, ShieldAlert } from "lucide-react";
import { DEFAULT_DISABLED_POLICY_RULES, type PolicyRuleId, type Settings } from "@forge/protocol";
import { Button } from "@/components/ui/button";
import { Group, SwitchRow } from "./layout";

const RULE_GROUPS: ReadonlyArray<{ title: string; description: string; rules: ReadonlyArray<{ id: PolicyRuleId; label: string; info: string }> }> = [
  {
    title: "Git",
    description: "Befehle, die Verlauf auf dem Remote oder nicht committete Arbeit unwiderruflich ändern.",
    rules: [
      { id: "git-force-push", label: "Force-Push", info: "git push --force, -f, --force-with-lease und +refspec. Überschreibt Commits auf dem Remote." },
      { id: "git-push-protected", label: "Push auf main und master", info: "Push auf main oder master und jeder Push, solange einer dieser Branches ausgecheckt ist. Standardmäßig aus." },
      { id: "git-push-delete", label: "Remote-Branches löschen", info: "git push --delete und git push origin :branch." },
      { id: "git-push-mirror", label: "Push mit --mirror oder --prune", info: "Beide löschen Branches auf dem Remote, die es lokal nicht gibt." },
      { id: "git-reset-hard", label: "git reset --hard", info: "Verwirft nicht committete Änderungen ohne Rückweg." },
      { id: "git-branch-delete", label: "Lokale Branches löschen", info: "git branch -d, -D und --delete. Im Git-Bereich kannst du Branches weiterhin selbst löschen." },
      { id: "git-clean-force", label: "git clean -f", info: "Löscht nicht versionierte Dateien endgültig." },
    ],
  },
  {
    title: "Dateien und Ordner",
    description: "Wo Claude schreiben und was Claude löschen darf.",
    rules: [
      {
        id: "write-outside-project",
        label: "Schreiben außerhalb des Projekts",
        info: "Nur im Profil Autonomous: Write und Edit ändern keine Dateien außerhalb des Projektordners. Lesen außerhalb ist nicht gesperrt.",
      },
      { id: "rm-root", label: "Wurzel- und Benutzerordner löschen", info: "rm -rf auf /, ~ oder ein Laufwerk, Remove-Item und rd auf C:\\ oder deinen Benutzerordner." },
      { id: "format-disk", label: "Datenträger formatieren", info: "format, mkfs, Format-Volume und diskpart." },
    ],
  },
  {
    title: "Zugangsdaten",
    description: "Schlüssel, Tokens und Anmeldungen auf diesem Rechner.",
    rules: [
      {
        id: "sensitive-path",
        label: "Zugangsdaten und Browserprofile",
        info: "Lesen, Schreiben und Befehle auf ~/.ssh, ~/.aws, ~/.config/gh, ~/.npmrc, Browserprofile und den Windows-Anmeldespeicher. Dazu gehören auch Suchen mit Grep und Glob über deinen ganzen Benutzerordner.",
      },
    ],
  },
];

/** The blocklist rules as switches: on means FORGE blocks it. Stored as the list of switched-off rules. */
export function PolicySettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const off = new Set(s.disabledPolicyRules);
  const set = (id: PolicyRuleId, active: boolean) => void save({ disabledPolicyRules: active ? s.disabledPolicyRules.filter((r) => r !== id) : [...s.disabledPolicyRules, id] });
  // Only rules switched off beyond the default are worth a warning.
  const extraOff = s.disabledPolicyRules.filter((r) => !DEFAULT_DISABLED_POLICY_RULES.includes(r)).length;

  return (
    <>
      {extraOff > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft/40 px-4 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-xs text-muted">
            {extraOff === 1 ? "Eine Regel ist" : `${extraOff} Regeln sind`} mehr ausgeschaltet als im Standard. Das gilt für alle Projekte und Profile, auch für Autonomous ohne Rückfrage.
          </p>
          <Button size="sm" variant="ghost" onClick={() => void save({ disabledPolicyRules: [...DEFAULT_DISABLED_POLICY_RULES] })}>
            <RotateCcw className="h-3.5 w-3.5" /> Standard wiederherstellen
          </Button>
        </div>
      )}
      {RULE_GROUPS.map((g) => (
        <Group key={g.title} title={g.title} description={g.description}>
          {g.rules.map((r) => (
            <SwitchRow
              key={r.id}
              label={r.label}
              description={
                <>
                  {r.info} <span className="font-mono text-subtle">{r.id}</span>
                </>
              }
              checked={!off.has(r.id)}
              onChange={(v) => set(r.id, v)}
            />
          ))}
        </Group>
      ))}
    </>
  );
}
