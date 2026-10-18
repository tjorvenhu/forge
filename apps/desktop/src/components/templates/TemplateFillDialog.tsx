import { useEffect, useMemo, useRef, useState } from "react";
import { FileStack } from "lucide-react";
import { fillTemplate, templatePlaceholders, type PromptTemplate } from "@forge/protocol";
import { t } from "@/i18n";
import { useProjects, useTemplates } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { startValues, useTemplateContext } from "./template-values";

export type TemplateSubmit = (text: string, o: { send: boolean; projectId: string; template: PromptTemplate }) => void;

/**
 * Asks for the placeholders of a template before it goes into the chat. Known ones (project, branch,
 * file, date) come filled in and stay editable. Without a template it first lets the user pick one,
 * without a project it asks for that too.
 */
export function TemplateFillDialog({
  open,
  onOpenChange,
  projectId: givenProject,
  template: givenTemplate,
  templateId,
  values: given,
  onSubmit,
  canSend = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string | null;
  template?: PromptTemplate | null;
  /** looked up in the project's templates; for requests that only carry the id */
  templateId?: string | null;
  values?: Record<string, string>;
  onSubmit: TemplateSubmit;
  canSend?: boolean;
}) {
  const projects = useProjects();
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const projectId = givenProject ?? pickedProject;
  const templates = useTemplates(projectId);
  const [picked, setPicked] = useState<PromptTemplate | null>(null);
  const template = givenTemplate ?? picked ?? (templateId ? (templates.data?.find((tpl) => tpl.id === templateId) ?? null) : null);
  const ctx = useTemplateContext(projectId);
  const [values, setValues] = useState<Record<string, string>>({});
  const holes = useMemo(() => (template ? templatePlaceholders(template.text) : []), [template]);

  useEffect(() => {
    if (!open) {
      setPicked(null);
      setPickedProject(null);
    }
  }, [open]);
  // Filled again for each template; what the user typed for another one does not carry over. Project and
  // branch arrive a moment later when they were not loaded yet.
  const startKey = `${template?.id ?? ""}:${projectId ?? ""}:${ctx.project ?? ""}:${ctx.branch ?? ""}`;
  const [filledFor, setFilledFor] = useState("");
  /** the field to type in next: the first one FORGE could not fill */
  const [focusName, setFocusName] = useState<string | null>(null);
  if (open && template && filledFor !== startKey) {
    const start = startValues(template.text, ctx, given);
    setFilledFor(startKey);
    setValues(start);
    setFocusName(holes.find((h) => !start[h]?.trim()) ?? holes[0] ?? null);
  }
  if (!open && filledFor) setFilledFor("");
  const fields = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => {
    if (focusName) fields.current[focusName]?.focus();
  }, [focusName, filledFor]);

  const missing = holes.filter((h) => !values[h]?.trim());
  const text = template ? fillTemplate(template.text, values) : "";
  const submit = (send: boolean) => {
    if (!template || !projectId || (send && missing.length)) return;
    onSubmit(text, { send, projectId, template });
    onOpenChange(false);
  };

  const roots = (projects.data ?? []).filter((p) => !p.parentId && p.exists);
  const loadingList = !!projectId && !givenTemplate && !templateId && templates.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={template ? t.templates.fill.title(template.name) : t.templates.fill.titleApply}
      description={template?.description ?? undefined}
      className="w-150"
      footer={
        template && projectId ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t.templates.common.cancel}
            </Button>
            <Button variant={canSend ? "secondary" : "primary"} onClick={() => submit(false)}>
              {t.templates.fill.takeIntoChat}
            </Button>
            {canSend && (
              <Button variant="primary" disabled={missing.length > 0} onClick={() => submit(true)} title={missing.length ? t.templates.fill.stillMissing(missing.join(", ")) : undefined}>
                {t.templates.fill.send}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {!givenProject && (
          <Field label={t.templates.fill.project}>
            <Select
              value={pickedProject ?? undefined}
              onChange={setPickedProject}
              options={roots.map((p) => ({ value: p.id, label: p.name }))}
              placeholder={t.templates.fill.pickProject}
              className="w-full"
              aria-label={t.templates.fill.project}
            />
          </Field>
        )}
        {projectId && !template &&
          (loadingList ? (
            <SkeletonRegion label={t.templates.common.loading}className="flex flex-col gap-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1.5 rounded-lg px-3 py-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
              ))}
            </SkeletonRegion>
          ) : templates.data?.length ? (
            <div className="flex flex-col gap-1" role="listbox" aria-label={t.templates.common.templatesLabel}>
              {templates.data.map((tpl) => (
                <button
                  key={tpl.id}
                  role="option"
                  aria-selected={false}
                  onClick={() => setPicked(tpl)}
                  className="flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
                >
                  <span className="text-body font-medium">{tpl.name}</span>
                  <span className="line-clamp-1 text-xs text-muted">{tpl.description || tpl.text}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon={<FileStack className="h-5 w-5" />} title={t.templates.fill.emptyTitle}>
              {t.templates.fill.emptyBody}
            </EmptyState>
          ))}
        {template && projectId && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(canSend && !missing.length);
            }}
          >
            {holes.map((h) => (
              <Field key={h} label={h}>
                <Input
                  ref={(el) => {
                    fields.current[h] = el;
                  }}
                  value={values[h] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [h]: e.target.value }))}
                  aria-label={t.templates.fill.placeholderAria(h)}
                />
              </Field>
            ))}
            {/* Enter in a field submits; the form needs a submit button for that. */}
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
            <div>
              <span className="mb-1.5 block text-xs font-medium text-muted">{t.templates.fill.preview}</span>
              <pre className={cn("max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-2 px-3 py-2 font-sans text-body", !holes.length && "max-h-72")}>{text}</pre>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
