import type { RemoteSession, RemoteState, ServerEvent, SessionEventBody } from "@forge/protocol";
import type { ClaudeRuntime } from "../claude/runtime.js";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { describeRuntimeError, type LiveSession } from "./live-session.js";

export interface BridgeHost {
  live(sessionId: string): LiveSession | undefined;
  liveIds(): string[];
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  /** a CLI turn started without a FORGE message (Claude app, or an own message queued in the CLI) */
  turnStarted(sessionId: string, live: LiveSession, fromRemote: boolean): void;
  titleFromFirstMessage(sessionId: string, text: string): void;
}

interface RemoteUserContent {
  text: string;
  images: Array<{ mediaType: string; size: number }>;
}

/** Leaves room for a " (n)" suffix within the name length the Claude app shows. */
const NAME_MAX = 110;

/**
 * Remote Control (Claude app / claude.ai): while switched on, every FORGE session with a running CLI
 * process (all projects, the same set as the session tabs) is its own entry in the Claude app.
 * Sessions that start or resume later are connected automatically; FORGE never opens a session for it.
 * The wire messages used here (bridge_state, command_lifecycle, replayed user messages) are not typed
 * in the SDK, so every field is checked before use and unknown shapes are ignored.
 */
export class RemoteBridge {
  /** sessionId → connected session; null while Remote is switched off */
  private sessions: Map<string, RemoteSession> | null = null;

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    private readonly runtime: ClaudeRuntime,
    private readonly host: BridgeHost,
  ) {}

  enabled(): boolean {
    return this.sessions !== null;
  }

  state(): RemoteState {
    return { enabled: this.enabled(), sessions: [...(this.sessions?.values() ?? [])] };
  }

  private emitState() {
    this.host.emit({ event: "remote.updated", payload: this.state() });
  }

  /** Patches the entry of a connected session; with an empty patch it only refreshes the title. */
  update(sessionId: string, patch: Partial<RemoteSession>) {
    const cur = this.sessions?.get(sessionId);
    const rec = this.db.getSession(sessionId);
    if (!cur || !rec) return;
    this.sessions!.set(sessionId, { ...cur, title: rec.title ?? "", ...patch });
    this.emitState();
  }

  drop(sessionId: string) {
    if (this.sessions?.delete(sessionId)) this.emitState();
  }

  /**
   * Switches Remote Control on and connects every running session that is not connected yet (failed
   * ones are retried). Messages show up on both sides; FORGE's approvals and policy keep applying.
   * Without a running session Remote is just on: nothing is started.
   */
  async start(): Promise<RemoteState> {
    const map = (this.sessions ??= new Map());
    const todo = this.host.liveIds().filter((id) => (map.get(id)?.state ?? "error") === "error");
    await Promise.all(todo.map((id) => this.bridge(id)));
    this.emitState();
    return this.state();
  }

  async stop(): Promise<RemoteState> {
    const ids = [...(this.sessions?.keys() ?? [])];
    this.sessions = null;
    await Promise.all(ids.map((id) => this.host.live(id)?.rt.setRemoteControl(false, "").catch(() => {})));
    this.emitState();
    return this.state();
  }

  async bridge(sessionId: string) {
    const map = this.sessions;
    const live = this.host.live(sessionId);
    const rec = this.db.getSession(sessionId);
    if (!map || !live || !rec) return;
    const project = this.projects.get(rec.projectId);
    const title = rec.title ?? "";
    const name = this.uniqueName(sessionId, `FORGE · ${project.name}: ${title || "Session"}`);
    map.set(sessionId, { sessionId, projectId: rec.projectId, projectName: project.name, title, name, url: null, state: "connecting", message: null });
    this.emitState();
    try {
      const url = await live.rt.setRemoteControl(true, name);
      if (this.sessions !== map) {
        // Switched off while connecting. Off and on again: the new start connects it itself.
        if (!this.sessions) await live.rt.setRemoteControl(false, name).catch(() => {});
        return;
      }
      if (this.host.live(sessionId) === live) this.update(sessionId, { url });
    } catch (e) {
      if (this.sessions === map && this.host.live(sessionId) === live) this.update(sessionId, { state: "error", message: describeRuntimeError(e) });
    }
  }

  /** Two sessions with the same project and title must still be told apart in the Claude app. */
  private uniqueName(sessionId: string, base: string): string {
    const short = base.length > NAME_MAX ? `${base.slice(0, NAME_MAX - 1)}…` : base;
    const taken = new Set([...(this.sessions?.values() ?? [])].filter((s) => s.sessionId !== sessionId).map((s) => s.name));
    let name = short;
    for (let n = 2; taken.has(name); n++) name = `${short} (${n})`;
    return name;
  }

  /** Reason for an approval prompt that was aborted by the CLI. */
  abortReason(sessionId: string): string {
    return this.sessions?.has(sessionId) ? "In der Claude-App beantwortet oder abgebrochen" : "Abgebrochen";
  }

  /**
   * Remote Control input: the bridge status, a turn started by a message from the Claude app and the
   * echo of that message. Returns true when the message is fully handled here.
   */
  handleInput(id: string, live: LiveSession, m: Record<string, unknown>): boolean {
    if (m.type === "system" && m.subtype === "bridge_state") {
      const state = typeof m.state === "string" ? m.state : "";
      if (state === "connected") this.update(id, { state: "connected", message: null });
      else if (state === "failed" || state === "error") this.update(id, { state: "error", message: typeof m.error === "string" ? m.error : null });
      else if (state === "disconnected" || state === "reconnecting") this.update(id, { state: "connecting" });
      return true;
    }
    if (m.type === "command_lifecycle") {
      if (m.state === "started" && typeof m.command_uuid === "string") {
        // Also own messages: one queued during a turn that ended first starts its own turn now.
        this.host.turnStarted(id, live, !live.seenUuids.has(m.command_uuid));
      }
      return true;
    }
    if (m.type === "user" && m.isReplay === true) {
      const uuid = typeof m.uuid === "string" ? m.uuid : null;
      if (!uuid || live.seenUuids.has(uuid) || m.isSynthetic === true) return true;
      const parsed = remoteUserContent((m.message as Record<string, unknown> | undefined)?.content);
      if (parsed) this.recordMessage(id, live, uuid, parsed);
      return true;
    }
    return false;
  }

  /** At the end of a turn the Claude app started: fetch its message from the transcript if no echo came. */
  endTurn(id: string, live: LiveSession) {
    if (live.remoteTurn && !live.remoteTurn.sawMessage) void this.syncMessages(id, live);
    live.remoteTurn = null;
  }

  private recordMessage(id: string, live: LiveSession, uuid: string, msg: RemoteUserContent) {
    live.seenUuids.add(uuid);
    if (live.remoteTurn) live.remoteTurn.sawMessage = true;
    const attachments = msg.images.map((img, i) => ({ name: `Bild ${i + 1}`, mediaType: img.mediaType, size: img.size }));
    this.host.record(id, { type: "user.message", text: msg.text, uuid, source: "remote", ...(attachments.length ? { attachments } : {}) });
    this.host.titleFromFirstMessage(id, msg.text);
  }

  /** Fallback when the CLI did not echo a message from the Claude app: read it from the transcript. */
  private async syncMessages(id: string, live: LiveSession) {
    const rec = this.db.getSession(id);
    if (!rec?.claudeSessionId) return;
    try {
      const msgs = (await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd)) as Array<Record<string, unknown>>;
      const users = msgs.filter((m) => m.type === "user" && typeof m.uuid === "string");
      const lastSeen = users.map((m) => live.seenUuids.has(m.uuid as string)).lastIndexOf(true);
      for (const m of users.slice(lastSeen + 1)) {
        const parsed = remoteUserContent((m.message as Record<string, unknown> | undefined)?.content);
        if (parsed) this.recordMessage(id, live, m.uuid as string, parsed);
      }
    } catch {
      /* transcript not readable: the answer is still in the timeline */
    }
  }
}

/** Text and images of a message typed in the Claude app; null for tool results and empty content. */
function remoteUserContent(content: unknown): RemoteUserContent | null {
  if (typeof content === "string") return content.trim() ? { text: content, images: [] } : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const images: RemoteUserContent["images"] = [];
  for (const b of content as Array<Record<string, unknown> | null>) {
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b?.type === "image") {
      const src = (b.source ?? {}) as Record<string, unknown>;
      const data = typeof src.data === "string" ? src.data : "";
      images.push({ mediaType: typeof src.media_type === "string" ? src.media_type : "image", size: Math.floor((data.length * 3) / 4) });
    } else if (b?.type === "tool_result") return null;
  }
  const text = texts.join("\n");
  return text.trim() || images.length ? { text, images } : null;
}
