import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, ShieldAlert } from "lucide-react";
import { DEFAULT_DISABLED_POLICY_RULES, type PolicyRuleId, type Settings } from "@forge/protocol";
import { keys } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { Group, SwitchRow } from "./layout";

const p = t.settings.policy;

export const RULE_GROUPS: ReadonlyArray<{ title: string; description: string; rules: ReadonlyArray<{ id: PolicyRuleId; label: string; info: string }> }> = [
  {
    title: p.git.title,
    description: p.git.description,
    rules: [
      { id: "git-force-push", ...p.git.forcePush },
      { id: "git-push-protected", ...p.git.pushProtected },
      { id: "git-push-delete", ...p.git.pushDelete },
      { id: "git-push-mirror", ...p.git.pushMirror },
      { id: "git-reset-hard", ...p.git.resetHard },
      { id: "git-branch-delete", ...p.git.branchDelete },
      { id: "git-clean-force", ...p.git.cleanForce },
    ],
  },
  {
    title: p.files.title,
    description: p.files.description,
    rules: [
      { id: "write-outside-project", ...p.files.writeOutside },
      { id: "rm-root", ...p.files.rmRoot },
      { id: "format-disk", ...p.files.formatDisk },
    ],
  },
  {
    title: p.credentials.title,
    description: p.credentials.description,
    rules: [{ id: "sensitive-path", ...p.credentials.sensitivePath }],
  },
];

/** The blocklist rules as switches: on means FORGE blocks it. Stored as the list of switched-off rules. */
export function PolicySettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const qc = useQueryClient();
  const off = new Set(s.disabledPolicyRules);
  // The list is saved whole: one switch at a time, each built on what the last save returned,
  // otherwise two quick clicks both start from the same rendered list and undo each other.
  const queue = useRef(Promise.resolve());
  const set = (id: PolicyRuleId, active: boolean) => {
    queue.current = queue.current.then(() => {
      const rest = (qc.getQueryData<Settings>(keys.settings) ?? s).disabledPolicyRules.filter((r) => r !== id);
      return save({ disabledPolicyRules: active ? rest : [...rest, id] });
    });
  };
  // Only rules switched off beyond the default are worth a warning.
  const extraOff = s.disabledPolicyRules.filter((r) => !DEFAULT_DISABLED_POLICY_RULES.includes(r)).length;

  return (
    <>
      {extraOff > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft/40 px-4 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-xs text-muted">
            {p.extraOff(extraOff)}
          </p>
          <Button size="sm" variant="ghost" onClick={() => void save({ disabledPolicyRules: [...DEFAULT_DISABLED_POLICY_RULES] })}>
            <RotateCcw className="h-3.5 w-3.5" /> {p.restoreDefault}
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
