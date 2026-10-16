import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KNOWN_PLACEHOLDERS, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX, TEMPLATE_TEXT_MAX, templatePlaceholders, type PromptTemplate } from "@forge/protocol";
import { call, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";

const GLOBAL = "__global";

/** A name from the first line of a message, for "Als Vorlage speichern". */
export function nameFromText(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ");
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

/**
 * Creates or edits a prompt template: name, optional description, the text with placeholders in braces
 * and where it applies (global or one project).
 */
export function TemplateEditorDialog({
  open,
  onOpenChange,
  template,
  initialText,
  initialProjectId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** null: a new template */
  template: PromptTemplate | null;
  initialText?: string;
  initialProjectId?: string | null;
  onSaved?: (t: PromptTemplate) => void;
}) {
  const qc = useQueryClient();
  const projects = useProjects().data ?? [];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [scope, setScope] = useState(GLOBAL);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? (initialText ? nameFromText(initialText) : ""));
    setDescription(template?.description ?? "");
    setText(template?.text ?? initialText ?? "");
    setScope(template?.projectId ?? initialProjectId ?? GLOBAL);
  }, [open, template, initialText, initialProjectId]);

  const holes = templatePlaceholders(text);
  // Worktrees of agents share their project's templates.
  const roots = projects.filter((p) => !p.parentId);
  const scopeOptions = [
    { value: GLOBAL, label: "Global", description: "In jedem Projekt" },
    ...roots.map((p) => ({ value: p.id, label: p.name, description: "Nur in diesem Projekt" })),
  ];
  const value = scope === GLOBAL ? GLOBAL : (projects.find((p) => p.id === scope)?.parentId ?? scope);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await call("templates.save", {
        id: template?.id ?? null,
        projectId: value === GLOBAL ? null : value,
        name: name.trim(),
        description: description.trim() || null,
        text,
      });
      void qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success(template ? "Vorlage gespeichert" : "Vorlage angelegt", saved.name);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      toast.error("Vorlage nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={template ? "Vorlage bearbeiten" : "Neue Vorlage"}
      className="w-160"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !text.trim()} onClick={() => void save()}>
            {template ? "Speichern" : "Anlegen"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_14rem] gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={TEMPLATE_NAME_MAX} placeholder="Review vor Release" autoFocus />
          </Field>
          <Field label="Gilt für">
            <Select value={value} onChange={setScope} options={scopeOptions} className="w-full" aria-label="Gilt für" />
          </Field>
        </div>
        <Field label="Beschreibung" hint="Optional, erscheint in Vorschlägen und in der Suche">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={TEMPLATE_DESCRIPTION_MAX} />
        </Field>
        <Field label="Text" hint="Platzhalter in geschweiften Klammern, etwa {datei} oder {thema}. FORGE fragt sie vor dem Senden ab.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={TEMPLATE_TEXT_MAX} rows={9} className="font-mono text-xs" aria-label="Text der Vorlage" />
        </Field>
        {holes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            Platzhalter:
            {holes.map((h) => (
              <Badge key={h} tone={KNOWN_PLACEHOLDERS[h.toLowerCase()] ? "accent" : "neutral"}>
                {`{${h}}`}
              </Badge>
            ))}
            {holes.some((h) => KNOWN_PLACEHOLDERS[h.toLowerCase()]) && <span className="text-subtle">Farbige füllt FORGE selbst vor.</span>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
