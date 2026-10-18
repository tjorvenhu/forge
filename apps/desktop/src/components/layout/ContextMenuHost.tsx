import { Fragment, useEffect, useState } from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { ClipboardPaste, Copy, ExternalLink, Link2, Redo2, Scissors, Search, TextSelect, Undo2 } from "lucide-react";
import { copyText, offeredGroups, type ContextGroup } from "@/lib/context-menu";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { MENU_CONTENT_CLASS, MenuEntry } from "@/components/ui/dropdown";
import { t } from "@/i18n";

const ICON = "h-3.5 w-3.5";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** An input that holds text (not a checkbox or button): only those have a selection. */
function textField(el: Element | null): TextField | null {
  const f = el?.closest("input, textarea");
  if (!(f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) return null;
  try {
    return f.selectionStart === null ? null : f;
  } catch {
    return null;
  }
}

/**
 * Cut, copy, paste for the field under the click. The menu takes the focus, so every entry first puts
 * focus and selection back where they were; execCommand keeps the field's own undo history.
 */
function editGroup(target: Element | null): ContextGroup | null {
  const field = textField(target);
  const editable = field ? null : (target?.closest<HTMLElement>("[contenteditable='true'], [contenteditable='']") ?? null);
  if (!field && !editable) return null;
  const sel = window.getSelection();
  const range = editable && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const start = field?.selectionStart ?? 0;
  const end = field?.selectionEnd ?? 0;
  const selected = field ? field.value.slice(start, end) : (sel?.toString() ?? "");
  const writable = field ? !field.readOnly && !field.disabled : true;
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const restore = () => {
    if (field) {
      field.focus();
      field.setSelectionRange(start, end);
    } else if (editable) {
      editable.focus();
      if (range) {
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };
  const run = (command: string, value?: string) => {
    restore();
    document.execCommand(command, false, value);
  };
  return [
    { label: t.layout.contextMenu.undo, icon: <Undo2 className={ICON} />, hint: t.layout.contextMenu.key("Z"), disabled: !writable, onSelect: () => run("undo") },
    { label: t.layout.contextMenu.redo, icon: <Redo2 className={ICON} />, hint: t.layout.contextMenu.key("Y"), disabled: !writable, onSelect: () => run("redo") },
    {
      label: t.layout.contextMenu.cut,
      icon: <Scissors className={ICON} />,
      hint: t.layout.contextMenu.key("X"),
      disabled: !writable || !selected || secret,
      onSelect: () => {
        copyText(selected);
        run("delete");
      },
    },
    { label: t.layout.contextMenu.copy, icon: <Copy className={ICON} />, hint: t.layout.contextMenu.key("C"), disabled: !selected || secret, onSelect: () => copyText(selected) },
    {
      label: t.layout.contextMenu.paste,
      icon: <ClipboardPaste className={ICON} />,
      hint: t.layout.contextMenu.key("V"),
      disabled: !writable,
      onSelect: () => {
        navigator.clipboard.readText().then(
          (text) => run("insertText", text),
          () => toast.error(t.layout.contextMenu.pasteFailed, t.layout.contextMenu.pasteFailedDetail),
        );
      },
    },
    {
      label: t.layout.contextMenu.selectAll,
      icon: <TextSelect className={ICON} />,
      hint: t.layout.contextMenu.key("A"),
      onSelect: () => {
        if (field) {
          field.focus();
          field.select();
        } else run("selectAll");
      },
    },
  ];
}

/** What every right click offers besides the entries of the element: the link, the field or the selected text, and the search. */
export function generalGroups(target: Element | null): ContextGroup[] {
  const groups: ContextGroup[] = [];
  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (link && /^https?:\/\//.test(link.href)) {
    const href = link.href;
    groups.push([
      { label: t.layout.contextMenu.openLink, icon: <ExternalLink className={ICON} />, onSelect: () => void openExternal(href) },
      { label: t.layout.contextMenu.copyLink, icon: <Link2 className={ICON} />, onSelect: () => copyText(href) },
    ]);
  }
  // A region with its own copy and paste (the terminal) keeps the general ones out.
  const plain = !!target?.closest("[data-context-plain]");
  const edit = plain ? null : editGroup(target);
  if (edit) groups.push(edit);
  else if (!plain) {
    const text = window.getSelection()?.toString() ?? "";
    if (text.trim()) groups.push([{ label: t.layout.contextMenu.copy, icon: <Copy className={ICON} />, hint: t.layout.contextMenu.key("C"), onSelect: () => copyText(text) }]);
  }
  groups.push([{ label: t.layout.contextMenu.search, icon: <Search className={ICON} />, hint: t.layout.contextMenu.key("K"), onSelect: () => useUi.getState().setPaletteOpen(true) }]);
  return groups;
}

interface OpenMenu {
  x: number;
  y: number;
  groups: ContextGroup[];
  id: number;
}

/**
 * FORGE's own right-click menu instead of the browser one, in every window. Components add their
 * entries with addContextItems; a handler that calls preventDefault keeps the click for itself.
 */
export function ContextMenuHost({ search = true }: { search?: boolean }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  useEffect(() => {
    let id = 0;
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      const general = generalGroups(target);
      const groups = [...offeredGroups(e), ...(search ? general : general.slice(0, -1))].filter((g) => g.length);
      setMenu(groups.length ? { x: e.clientX, y: e.clientY, groups, id: ++id } : null);
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, [search]);
  if (!menu) return null;
  return (
    <M.Root key={menu.id} open modal={false} onOpenChange={(open) => !open && setMenu(null)}>
      <M.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed h-0 w-0" style={{ left: menu.x, top: menu.y }} />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          className={MENU_CONTENT_CLASS}
          // Focus goes where the chosen entry put it (a text field), not back to the invisible anchor.
          onCloseAutoFocus={(e) => e.preventDefault()}
          aria-label={t.layout.contextMenu.label}
        >
          {menu.groups.map((g, gi) => (
            <Fragment key={gi}>
              {gi > 0 && <M.Separator className="-mx-1 my-1 h-px bg-border" />}
              {g.map((item, i) => (
                <MenuEntry key={i} item={item} />
              ))}
            </Fragment>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
