import { useAllTemplates } from "@/lib/queries";
import { activeDraftKey, useDrafts } from "@/stores/drafts";
import { useTemplateDialogs } from "@/stores/templates";
import { useUi } from "@/stores/ui";
import { focusComposer, MAIN_SLOT } from "@/components/workspace/chat-slot";
import { TemplateEditorDialog } from "./TemplateEditorDialog";
import { TemplateFillDialog } from "./TemplateFillDialog";

/**
 * Puts a filled template into the chat of a project: the project opens, the text lands in the draft of
 * the chat it shows (after what is already typed there) and the composer gets the focus. Sending stays
 * with the user.
 */
export function insertIntoChat(projectId: string, text: string) {
  const ui = useUi.getState();
  ui.openProject(projectId);
  const key = activeDraftKey(projectId, useUi.getState().activeSession[projectId]);
  const drafts = useDrafts.getState();
  const cur = drafts.drafts[key]?.text ?? "";
  drafts.setText(key, cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text);
  // The workspace may only mount now.
  window.setTimeout(() => focusComposer(MAIN_SLOT), 60);
}

/**
 * Dialogs for templates opened from outside the composer: apply one (palette, right click on a file or
 * project) and create or edit one (right click on an own message, palette). `apply` false: a chat
 * window, which has no workspace to put the text into.
 */
export function TemplateHost({ apply = true }: { apply?: boolean }) {
  const req = useTemplateDialogs((s) => s.apply);
  const edit = useTemplateDialogs((s) => s.edit);
  const closeApply = useTemplateDialogs((s) => s.closeApply);
  const closeEdit = useTemplateDialogs((s) => s.closeEdit);
  const all = useAllTemplates(!!edit?.id);
  const editing = edit?.id ? (all.data?.find((tpl) => tpl.id === edit.id) ?? null) : null;
  return (
    <>
      {apply && (
        <TemplateFillDialog
          open={!!req}
          onOpenChange={(o) => !o && closeApply()}
          projectId={req?.projectId ?? null}
          templateId={req?.templateId ?? null}
          values={req?.values}
          canSend={false}
          onSubmit={(text, { projectId }) => insertIntoChat(projectId, text)}
        />
      )}
      <TemplateEditorDialog
        open={!!edit && (!edit.id || !!editing)}
        onOpenChange={(o) => !o && closeEdit()}
        template={editing}
        initialText={edit?.text}
        initialProjectId={edit?.projectId ?? null}
      />
    </>
  );
}
