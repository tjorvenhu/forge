import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronRight, ClipboardList, MessageCircleQuestion, X } from "lucide-react";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import type { ChatItem } from "./chat-items";
import { Markdown } from "./Markdown";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

export function parseQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return (input.questions as Array<Record<string, unknown>>)
    .filter((q) => q && typeof q.question === "string")
    .map((q) => ({
      question: q.question as string,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
        .filter((o) => o && typeof o.label === "string")
        .map((o) => ({
          label: o.label as string,
          description: typeof o.description === "string" ? o.description : "",
          preview: typeof o.preview === "string" ? o.preview : undefined,
        })),
    }));
}

/** Answer per question as Claude Code expects it: the label, several joined with ", ", or free text. */
export function buildAnswers(questions: Question[], picked: string[][], other: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const own = other[i]?.trim() ?? "";
    const parts = q.multiSelect ? [...(picked[i] ?? []), ...(own ? [own] : [])] : own ? [own] : (picked[i] ?? []).slice(0, 1);
    if (parts.length) out[q.question] = parts.join(", ");
  });
  return out;
}

function useRespond(sessionId: string, requestId: string | undefined) {
  return useMutation({
    mutationFn: (p: { decision: "allow" | "deny"; message?: string; answers?: Record<string, string> }) =>
      call("sessions.respondApproval", { sessionId, requestId: requestId!, decision: p.decision, scope: "once", message: p.message, answers: p.answers }),
    onError: (e) => toast.error("Antwort nicht übermittelt", errorMessage(e)),
  });
}

function CardHeader({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
      <span className="text-accent">{icon}</span>
      <span className="font-medium">{title}</span>
      <div className="flex-1" />
      {children}
    </div>
  );
}

/** Claude asks the user (AskUserQuestion): options to pick, free text, answers go back into the turn. */
export function QuestionCard({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const req = item.approval?.req;
  const resolved = item.approval?.resolved ?? null;
  const questions = parseQuestions(req?.input ?? item.use.input);
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const respond = useRespond(sessionId, req?.requestId);
  const pending = !!req && !resolved;
  const answers = buildAnswers(questions, picked, other);
  const complete = questions.length > 0 && questions.every((q) => answers[q.question]);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((cur) => cur.map((p, i) => (i !== qi ? p : multi ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label])));
    if (!multi) setOther((cur) => cur.map((o, i) => (i === qi ? "" : o)));
  };

  return (
    <div className={cn("rounded-lg border bg-surface", pending ? "border-accent/60" : "border-border")} role="group" aria-label="Rückfrage von Claude">
      <CardHeader icon={<MessageCircleQuestion className="h-4 w-4" />} title={pending ? "Claude hat eine Rückfrage" : "Rückfrage"}>
        {resolved && <ResolvedBadge decision={resolved.decision} source={resolved.source} allowText="Beantwortet" denyText="Übersprungen" />}
      </CardHeader>
      <div className="space-y-3 border-t border-border px-3 py-2.5">
        {questions.map((q, qi) => {
          const given = resolved?.answers?.[q.question];
          const focused = q.options.find((o) => picked[qi]?.includes(o.label) && o.preview);
          return (
            <div key={qi}>
              <div className="flex items-start gap-2">
                {q.header && <Badge tone="accent">{q.header}</Badge>}
                <div className="text-[13.5px]">{q.question}</div>
              </div>
              {pending ? (
                <>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {q.options.map((o) => {
                      const on = picked[qi]?.includes(o.label) ?? false;
                      return (
                        <button
                          key={o.label}
                          onClick={() => toggle(qi, o.label, q.multiSelect)}
                          aria-pressed={on}
                          className={cn(
                            "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                            on ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                              q.multiSelect ? "rounded" : "rounded-full",
                              on ? "border-accent bg-accent" : "border-border-strong",
                            )}
                          >
                            {on && <Check className="h-2.5 w-2.5 text-accent-fg" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium">{o.label}</span>
                            {o.description && <span className="block text-xs text-muted">{o.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {focused?.preview && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono text-[11.5px] text-muted">{focused.preview}</pre>}
                  <Input
                    value={other[qi] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOther((cur) => cur.map((o, i) => (i === qi ? v : o)));
                      if (!q.multiSelect && v) setPicked((cur) => cur.map((p, i) => (i === qi ? [] : p)));
                    }}
                    placeholder={q.multiSelect ? "Weitere Antwort (optional)" : "Eigene Antwort"}
                    className="mt-2 h-7 text-xs"
                    aria-label={`Eigene Antwort auf: ${q.question}`}
                  />
                </>
              ) : (
                <div className="mt-1 text-[13px] text-muted">
                  {given ? (
                    <span className="text-fg">{given}</span>
                  ) : resolved?.decision === "deny" ? (
                    "Nicht beantwortet"
                  ) : (
                    q.options.map((o) => o.label).join(" · ")
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!questions.length && <div className="text-xs text-muted">Die Rückfrage enthält keine lesbaren Fragen.</div>}
        {!req && item.result && <div className="text-xs text-subtle">{item.result.content.text}</div>}
      </div>
      {pending && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-xs text-subtle">Claude wartet auf deine Antwort.</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => respond.mutate({ decision: "deny" })} disabled={respond.isPending}>
            Überspringen
          </Button>
          <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "allow", answers })} disabled={!complete} loading={respond.isPending}>
            Antworten
          </Button>
        </div>
      )}
    </div>
  );
}

/** Claude presents a plan in plan mode (ExitPlanMode): accept it or send it back with feedback. */
export function PlanCard({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const req = item.approval?.req;
  const resolved = item.approval?.resolved ?? null;
  const input = req?.input ?? item.use.input;
  const plan = typeof input.plan === "string" ? input.plan : null;
  const pending = !!req && !resolved;
  const [open, setOpen] = useState(true);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const respond = useRespond(sessionId, req?.requestId);
  const showPlan = pending || open;

  return (
    <div className={cn("rounded-lg border bg-surface", pending ? "border-accent/60" : "border-border")} role="group" aria-label="Plan zur Freigabe">
      <CardHeader icon={<ClipboardList className="h-4 w-4" />} title={pending ? "Plan zur Freigabe" : "Plan"}>
        {resolved && <ResolvedBadge decision={resolved.decision} source={resolved.source} allowText="Angenommen" denyText="Zurück zur Überarbeitung" />}
        {!pending && (
          <button className="rounded p-0.5 text-subtle hover:text-fg" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Plan einklappen" : "Plan ausklappen"}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </CardHeader>
      {showPlan && (
        <div className="max-h-[28rem] overflow-y-auto border-t border-border px-4 py-3">
          {plan ? <Markdown text={plan} /> : <div className="text-xs text-muted">Claude hat keinen Plantext mitgeschickt.</div>}
        </div>
      )}
      {resolved?.decision === "deny" && resolved.source === "user" && resolved.message && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted">Feedback: {resolved.message}</div>
      )}
      {pending && (
        <div className="border-t border-border px-3 py-2">
          {revising ? (
            <div className="space-y-2">
              <Textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Was soll Claude am Plan ändern?"
                aria-label="Feedback zum Plan"
                className="text-[13px]"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRevising(false)} disabled={respond.isPending}>
                  Abbrechen
                </Button>
                <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "deny", message: feedback })} disabled={!feedback.trim()} loading={respond.isPending}>
                  Feedback senden
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-subtle">Nach dem Annehmen setzt Claude den Plan im Modus deines Profils um.</span>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => setRevising(true)} disabled={respond.isPending}>
                Überarbeiten
              </Button>
              <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "allow" })} loading={respond.isPending}>
                Plan annehmen
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResolvedBadge({ decision, source, allowText, denyText }: { decision: "allow" | "deny"; source: string; allowText: string; denyText: string }) {
  if (source === "abort") return <Badge>Abgebrochen</Badge>;
  return decision === "allow" ? (
    <Badge tone="success">
      <Check className="h-3 w-3" /> {allowText}
    </Badge>
  ) : (
    <Badge tone="warning">
      <X className="h-3 w-3" /> {denyText}
    </Badge>
  );
}
