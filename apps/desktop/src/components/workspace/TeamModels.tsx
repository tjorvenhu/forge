import { modelFamily, TEAM_MODEL_FAMILIES, TEAM_ROLE_SPECS, TEAM_ROLES, teamRoleModel, type AgentTeam, type ModelTokens, type TeamModelFamily, type TeamRole, type TeamRoleModels } from "@forge/protocol";
import { Coins } from "lucide-react";
import { useSessionUsage } from "@/lib/queries";
import { MODEL_META, ROLE_META } from "@/lib/agent-teams";
import { cn, formatTokens } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";

/** One select per role, the default model of the role marked; changes drop back to {} when set to the default. */
export function RoleModelsEditor({ value, onChange, compact = false }: { value: TeamRoleModels; onChange: (v: TeamRoleModels) => void; compact?: boolean }) {
  const tt = t.workspace.teams;
  const set = (role: TeamRole, model: TeamModelFamily) => {
    const next = { ...value };
    if (model === TEAM_ROLE_SPECS[role].model) delete next[role];
    else next[role] = model;
    onChange(next);
  };
  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]")}>
      {TEAM_ROLES.map((role) => {
        const meta = ROLE_META[role];
        const Icon = meta.icon;
        const current = teamRoleModel(role, value);
        return (
          <div key={role} className="flex items-start gap-2 rounded-lg border border-border bg-surface p-2">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: `${meta.color}22`, color: meta.color }}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-small font-medium">{tt.role[role]}</div>
              <Select
                size="sm"
                className="mt-1 w-full"
                aria-label={tt.roleModelAria(tt.role[role])}
                value={current}
                onChange={(m) => set(role, m)}
                options={TEAM_MODEL_FAMILIES.map((f) => ({
                  value: f,
                  label: f === TEAM_ROLE_SPECS[role].model ? tt.roleModelDefault(MODEL_META[f].label) : MODEL_META[f].label,
                  icon: <span className="h-2 w-2 rounded-full" style={{ background: MODEL_META[f].color }} />,
                }))}
              />
              <div className="mt-1 text-caption-lg leading-snug text-muted">{tt.roleInfo[role]}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const total = (m: ModelTokens) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;

/** Usage of the team by model family: a bar by estimated cost, tokens per model and the share of the plan's windows. */
export function TeamUsage({ team, className }: { team: AgentTeam; className?: string }) {
  const tt = t.workspace.teams;
  const usage = useSessionUsage(team.sessionId);
  const byFamily = new Map<string, { label: string; color: string; tokens: number; cost: number }>();
  for (const [model, m] of Object.entries(team.models)) {
    const f = modelFamily(model);
    const meta = f ? MODEL_META[f] : { label: model, color: "var(--color-subtle)" };
    const key = f ?? model;
    const cur = byFamily.get(key) ?? { label: meta.label, color: meta.color, tokens: 0, cost: 0 };
    cur.tokens += total(m);
    cur.cost += m.costUsd;
    byFamily.set(key, cur);
  }
  const rows = [...byFamily.values()].sort((a, b) => b.cost - a.cost);
  const cost = rows.reduce((n, r) => n + r.cost, 0);
  const windows = usage.data?.windows ?? [];
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-surface p-2.5", className)} title={tt.usageHint}>
      <div className="mb-1.5 flex items-center gap-1.5 text-caption-lg font-semibold uppercase tracking-wide text-muted">
        <Coins className="h-3.5 w-3.5" /> {tt.usage}
      </div>
      {rows.length ? (
        <>
          <div className="mb-2 flex h-1.5 overflow-hidden rounded-full bg-surface-3">
            {rows.map((r) => (
              <span key={r.label} className="h-full transition-[width] duration-500" style={{ width: `${cost ? (r.cost / cost) * 100 : 100 / rows.length}%`, background: r.color }} />
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-1.5 text-small">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                <span className="tabular-nums text-muted">{tt.usageModel(formatTokens(r.tokens), cost ? Math.round((r.cost / cost) * 100) : 0)}</span>
              </li>
            ))}
          </ul>
          {windows.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-1.5 text-caption-lg text-muted">
              {windows.slice(0, 2).map((w) => (
                <span key={w.key} className="tabular-nums">
                  {tt.usageShare(w.label, w.share < 1 && w.share > 0 ? "<1" : String(Math.round(w.share)))}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-small text-muted">{tt.usageNone}</p>
      )}
    </div>
  );
}
