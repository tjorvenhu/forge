import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Power, Search, Trash2 } from "lucide-react";
import type { Session } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBanner, Loading, Tooltip } from "@/components/ui/misc";
import { DeleteSessionDialog } from "@/components/workspace/DeleteSessionDialog";
import { Select } from "@/components/ui/select";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { ProfileBadge } from "@/components/projects/ProfileBadge";

const STATUS = [
  { value: "all", label: "Alle Status" },
  { value: "running", label: "Läuft" },
  { value: "waiting_approval", label: "Wartet auf Freigabe" },
  { value: "idle", label: "Bereit" },
  { value: "stopped", label: "Beendet" },
  { value: "interrupted", label: "Unterbrochen" },
  { value: "error", label: "Fehler" },
];

export function SessionsView() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const openProject = useUi((s) => s.openProject);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const sessions = useQuery({
    queryKey: keys.allSessions(q, status),
    queryFn: () => call("sessions.listAll", { query: q || undefined, status: status === "all" ? undefined : status }),
    placeholderData: (prev) => prev,
  });

  return (
    <Page title="Sessions" subtitle="Alle in FORGE gestarteten oder übernommenen Claude-Sessions">
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titel, Projekt oder Session-ID" className="pl-8" aria-label="Sessions durchsuchen" />
        </div>
        <Select value={status} onChange={setStatus} options={STATUS} className="w-52" aria-label="Status-Filter" />
      </div>
      {sessions.isLoading && <Loading />}
      {sessions.isError && <ErrorBanner>Sessions konnten nicht geladen werden.</ErrorBanner>}
      {sessions.isSuccess && sessions.data.length === 0 && (
        <EmptyState icon={<History className="h-10 w-10" />} title="Keine Sessions">
          Starte im Workspace eines Projekts eine neue Session. Im Terminal gestartete Sessions erscheinen im Workspace unter „Aus dem Terminal“.
        </EmptyState>
      )}
      {!!sessions.data?.length && (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Session</th>
                <th className="px-4 py-2 font-medium">Projekt</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Profil</th>
                <th className="px-4 py-2 font-medium">Modell</th>
                <th className="px-4 py-2 font-medium">Aktualisiert</th>
                <th className="w-px px-2 py-2">
                  <span className="sr-only">Aktionen</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.data.map((s) => (
                <tr key={s.id} className="cursor-pointer bg-surface hover:bg-surface-2" onClick={() => openProject(s.projectId, s.id)}>
                  <td className="max-w-80 px-4 py-2">
                    <button className="block w-full truncate text-left" onClick={() => openProject(s.projectId, s.id)}>
                      {s.title ?? "Ohne Titel"}
                    </button>
                    <div className="truncate font-mono text-[10px] text-subtle">{s.claudeSessionId ?? "noch keine Claude-ID"}</div>
                  </td>
                  <td className="px-4 py-2 text-muted">{s.projectName}</td>
                  <td className="px-4 py-2">
                    <SessionStatusBadge status={s.status} live={s.live} />
                  </td>
                  <td className="px-4 py-2">
                    <ProfileBadge profile={s.profile} />
                  </td>
                  <td className="px-4 py-2 text-muted">{s.model ?? "Standard"}</td>
                  <td className="px-4 py-2 text-muted">{relativeTime(s.updatedAt)}</td>
                  <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-0.5">
                      {s.live && (
                        <Tooltip content="Claude-Prozess beenden. Die Session bleibt fortsetzbar.">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Session beenden"
                            onClick={() => call("sessions.close", { sessionId: s.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)))}
                          >
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip content="Session löschen">
                        <Button size="icon-sm" variant="ghost" aria-label="Session löschen" className="hover:text-danger" onClick={() => setDeleting(s)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} />
    </Page>
  );
}
