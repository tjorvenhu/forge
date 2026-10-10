import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, FileText, ImageIcon, ListTodo, Paperclip, Square, X } from "lucide-react";
import type { Attachment, PermissionMode, Project, Session } from "@forge/protocol";
import { call, keys, useRuntimeInfo, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Kbd, Tooltip } from "@/components/ui/misc";

const PROFILE_MODE: Record<Project["profile"], PermissionMode> = { safe: "default", balanced: "acceptEdits", autonomous: "bypassPermissions" };
const MAX_ATTACHMENTS = 10;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

interface Pending {
  id: string;
  name: string;
  attachment: Attachment;
  /** object URL for pasted images */
  preview: string | null;
  isImage: boolean;
}

/** "claude-opus-5-5" -> "Opus 5.5" for models the picker does not list by alias. */
export function prettyModel(m: string): string {
  const core = m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
  return core.charAt(0).toUpperCase() + core.slice(1);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Lesefehler"));
    r.readAsDataURL(file);
  });
}

export function Composer({
  project,
  session,
  resumeClaudeSessionId,
  prefill,
  onPrefillConsumed,
}: {
  project: Project;
  session: Session | null;
  resumeClaudeSessionId?: string;
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [planOnly, setPlanOnly] = useState(project.tags.includes("plan-first"));
  const [model, setModel] = useState<string | null>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  const qc = useQueryClient();
  const setActive = useUi((s) => s.setActiveSession);
  const enterToSend = settings.data?.enterToSend ?? true;

  const working = session?.status === "running" || session?.status === "starting" || session?.status === "stopping";
  const waiting = session?.status === "waiting_approval";
  const effectiveModel = session ? session.model : (model ?? project.defaultModel ?? settings.data?.defaultModel ?? null);
  const isPlan = session ? session.permissionMode === "plan" : planOnly;

  // ---------- slash commands
  const slashMode = /^\/[^\s]*$/.test(text);
  const commands = useQuery({
    queryKey: ["commands", project.id],
    queryFn: () => call("system.commands", { projectId: project.id }),
    enabled: slashMode,
    staleTime: 5 * 60_000,
  });
  const matches = useMemo(() => {
    if (!slashMode) return [];
    const q = text.slice(1).toLowerCase();
    return (commands.data ?? []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [slashMode, text, commands.data]);
  useEffect(() => setCmdIndex(0), [text]);
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    ref.current?.focus();
  };

  // ---------- attachments
  const addPaths = (paths: string[]) => {
    setFiles((cur) => {
      const room = MAX_ATTACHMENTS - cur.length;
      if (paths.length > room) toast.info(`Höchstens ${MAX_ATTACHMENTS} Anhänge`);
      const add = paths.slice(0, Math.max(0, room)).map((p) => ({
        id: crypto.randomUUID(),
        name: p.split(/[\\/]/).pop() ?? p,
        attachment: { kind: "path" as const, path: p },
        preview: null,
        isImage: IMAGE_EXT.test(p),
      }));
      return [...cur, ...add];
    });
  };

  const addBlobs = async (list: File[]) => {
    for (const f of list.slice(0, MAX_ATTACHMENTS - files.length)) {
      if (f.size > 10 * 1024 * 1024) {
        toast.error("Datei zu groß", `${f.name || "Einfügung"} ist größer als 10 MB.`);
        continue;
      }
      const base64 = await readAsBase64(f);
      const name = f.name || `einfuegung-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`;
      setFiles((cur) => [
        ...cur,
        {
          id: crypto.randomUUID(),
          name,
          attachment: { kind: "data", name, mediaType: f.type || "application/octet-stream", base64 },
          preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
          isImage: f.type.startsWith("image/"),
        },
      ]);
    }
  };

  // Native drag and drop (Tauri delivers real file paths).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDragging(true);
        else if (e.payload.type === "leave") setDragging(false);
        else if (e.payload.type === "drop") {
          setDragging(false);
          addPaths(e.payload.paths);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const pickFiles = async () => {
    const r = await open({
      multiple: true,
      title: "Dateien anhängen",
      filters: [
        { name: "Bilder, PDF, Text", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "json", "csv", "log", "ts", "tsx", "js", "py", "rs", "go", "java", "cs", "html", "css", "yaml", "yml", "toml", "xml", "sql"] },
        { name: "Alle Dateien", extensions: ["*"] },
      ],
    });
    if (Array.isArray(r)) addPaths(r);
    else if (typeof r === "string") addPaths([r]);
  };

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillConsumed?.();
      ref.current?.focus();
    }
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  const send = async () => {
    const prompt = text.trim() || (files.length ? "Siehe Anhang." : "");
    if (!prompt || sending || working || waiting) return;
    setSending(true);
    const attachments = files.map((f) => f.attachment);
    try {
      if (!session) {
        const s = await call("sessions.start", { projectId: project.id, prompt, model: effectiveModel, planOnly, resumeClaudeSessionId, attachments });
        qc.setQueryData(keys.session(s.id), s);
        void qc.invalidateQueries({ queryKey: keys.sessions(project.id) });
        setActive(project.id, s.id);
      } else {
        const s = await call("sessions.send", { sessionId: session.id, text: prompt, attachments });
        qc.setQueryData(keys.session(s.id), s);
      }
      setText("");
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
    } catch (e) {
      toast.error("Nachricht nicht gesendet", errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    try {
      await call("sessions.stop", { sessionId: session.id });
    } catch (e) {
      toast.error("Stop fehlgeschlagen", errorMessage(e));
    }
  };

  const changeModel = async (v: string) => {
    const next = v === "__default" ? null : v;
    if (!session) return setModel(next);
    if (!next) return;
    try {
      qc.setQueryData(keys.session(session.id), await call("sessions.setModel", { sessionId: session.id, model: next }));
    } catch (e) {
      toast.error("Modell nicht gewechselt", errorMessage(e));
    }
  };

  const togglePlan = async () => {
    if (!session) return setPlanOnly(!planOnly);
    const mode: PermissionMode = isPlan ? PROFILE_MODE[session.profile] : "plan";
    try {
      qc.setQueryData(keys.session(session.id), await call("sessions.setPermissionMode", { sessionId: session.id, mode }));
    } catch (e) {
      toast.error("Modus nicht gewechselt", errorMessage(e));
    }
  };

  const models = runtime.data?.models.filter((m) => m.value !== "default") ?? [];
  const modelOptions = [
    ...(session ? [] : [{ value: "__default", label: "Standardmodell" }]),
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })),
  ];
  if (effectiveModel && !modelOptions.some((o) => o.value === effectiveModel)) modelOptions.push({ value: effectiveModel, label: prettyModel(effectiveModel), description: "" });

  const placeholder = waiting
    ? "Erst die Freigabeanfrage oben beantworten"
    : working
      ? "Claude arbeitet. Esc stoppt."
      : session && !session.live
        ? "Nachricht schreiben, um die Session fortzusetzen"
        : "Nachricht an Claude, / für Befehle, Dateien hineinziehen oder einfügen";

  return (
    <div className="relative shrink-0 px-6 pb-4 pt-2">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-6 right-6 z-20 mx-auto mb-1 max-w-4xl overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl" role="listbox" aria-label="Slash-Commands">
          {matches.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === cmdIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                pickCommand(c.name);
              }}
              className={cn("flex w-full items-baseline gap-3 px-3 py-1.5 text-left", i === cmdIndex ? "bg-surface-3" : "hover:bg-surface-3")}
            >
              <span className="shrink-0 font-mono text-[12.5px] text-accent">/{c.name}</span>
              {c.argumentHint && <span className="shrink-0 font-mono text-[11px] text-subtle">{c.argumentHint}</span>}
              <span className="min-w-0 truncate text-xs text-muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "relative mx-auto max-w-4xl rounded-xl border bg-surface-2 transition-colors",
          dragging ? "border-accent bg-accent-soft" : working ? "border-accent/40" : "border-border focus-within:border-accent",
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl text-[13px] text-accent">Dateien hier ablegen</div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-3 py-1 pl-1 pr-1.5 text-xs">
                {f.preview ? (
                  <img src={f.preview} alt="" className="h-8 w-8 rounded object-cover" />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-2 text-muted">
                    {f.isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>
                )}
                <span className="max-w-40 truncate" title={f.attachment.kind === "path" ? f.attachment.path : f.name}>
                  {f.name}
                </span>
                <button className="rounded p-0.5 text-subtle hover:text-fg" aria-label={`${f.name} entfernen`} onClick={() => {
                    if (f.preview) URL.revokeObjectURL(f.preview);
                    setFiles((cur) => cur.filter((x) => x.id !== f.id));
                  }}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          id="composer-input"
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              void addBlobs(pasted);
            }
          }}
          placeholder={placeholder}
          aria-label="Nachricht an Claude"
          rows={2}
          className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] text-fg placeholder:text-subtle focus:outline-none focus-visible:outline-none"
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCmdIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pickCommand(matches[cmdIndex]!.name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setText("");
                return;
              }
            }
            if (e.key === "Escape" && working) {
              e.preventDefault();
              void stop();
              return;
            }
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const submit = enterToSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
            if (submit) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
          <Tooltip content="Bilder, PDFs oder Textdateien anhängen (auch per Einfügen oder Hineinziehen)">
            <Button size="icon-sm" variant="ghost" onClick={() => void pickFiles()} aria-label="Dateien anhängen" disabled={files.length >= MAX_ATTACHMENTS}>
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={isPlan ? "Plan-Modus: Claude plant nur und ändert nichts" : "Nur planen (Plan-Modus)"}>
            <Button size="sm" variant={isPlan ? "secondary" : "ghost"} onClick={() => void togglePlan()} aria-pressed={isPlan} className={cn(isPlan && "text-accent")}>
              <ListTodo className="h-3.5 w-3.5" /> Planen
            </Button>
          </Tooltip>
          <div className="flex-1" />
          <span className="hidden text-[11px] text-subtle xl:inline">
            {enterToSend ? (
              <>
                <Kbd>Enter</Kbd> senden · <Kbd>Umschalt+Enter</Kbd> Zeile
              </>
            ) : (
              <>
                <Kbd>Strg+Enter</Kbd> senden
              </>
            )}
          </span>
          <Select size="sm" value={effectiveModel ?? "__default"} onChange={(v) => void changeModel(v)} options={modelOptions} className="w-40" aria-label="Modell" disabled={working} />
          {working ? (
            <Button size="icon-sm" variant="danger" onClick={() => void stop()} aria-label="Stoppen (Esc)" title="Stoppen (Esc)" disabled={session?.status === "stopping"}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon-sm" variant="primary" onClick={() => void send()} disabled={(!text.trim() && !files.length) || waiting} loading={sending} aria-label="Senden">
              {!sending && <ArrowUp className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
