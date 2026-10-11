import { useEffect, useState } from "react";
import type { ConfigDoc, ConfigDocKind, ConfigScope } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export function CreateDocDialog({
  kind,
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  kind: ConfigDocKind;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId?: string;
  onCreated: (d: ConfigDoc) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<ConfigScope>("user");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setScope("user");
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === "skill" ? "Skill anlegen" : "Subagent anlegen"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!/^[a-z0-9][a-z0-9-]*$/.test(name) || !description.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("config.docCreate", { kind, scope, name, description, projectId });
                onCreated({ kind, scope, name, description, path: r.path });
                onOpenChange(false);
              } catch (e) {
                toast.error("Nicht angelegt", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Anlegen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Kleinbuchstaben, Ziffern, Bindestriche">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="release-notes" autoFocus />
        </Field>
        <Field label="Beschreibung" hint="Woran Claude erkennt, wann er das hier nutzen soll">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Bereich">
          <Select<ConfigScope>
            value={scope}
            onChange={setScope}
            className="w-full"
            options={[
              { value: "user", label: "Global", description: "~/.claude, für alle Projekte" },
              ...(projectId ? [{ value: "project" as const, label: "Projekt", description: ".claude im Projekt, wird mit dem Repo geteilt" }] : []),
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
