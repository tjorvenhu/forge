import type { RemoteSession, RemoteState, ServerEvent, SessionEventBody } from "@forge/protocol";
import type { ClaudeRuntime } from "../claude/runtime.js";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { describeRuntimeError, REMOTE_PLACEHOLDER_TITLE, type LiveSession } from "./live-session.js";

export interface BridgeHost {
  live(sessionId: string): LiveSession | undefined;
  liveIds(): string[];
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  /** a CLI turn started without a FORGE message (Claude app, or an own message queued in the CLI) */
  turnStarted(sessionId: string, live: LiveSession, fromRemote: boolean): void;
  titleFromFirstMessage(sessionId: string, text: string): void;
  /** opens an empty session for the Claude app */
  startEmpty(projectId: string): Promise<unknown>;
}

interface RemoteUserContent {
  text: string;
  images: Array<{ mediaType: string; size: number }>;
}

/**
 * Remote Control (Claude app / claude.ai): connects the open FORGE sessions of a project to the
 * Claude app. The wire messages used here (bridge_state, command_lifecycle, replayed user messages)
 * are not typed in the SDK, so every field is checked before use and unknown shapes are ignored.
 */
export class RemoteBridge {
  /** projectId → bridged sessions; a project is in the map while Remote is switched on */
  private remote = new Map<string, Map<string, RemoteSession>>();

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    private readonly runtime: ClaudeRuntime,
    private readonly host: BridgeHost,
  ) {}

  enabled(projectId: string): boolean {
    return this.remote.has(projectId);
  }

  state(projectId: string): RemoteState {
    const sessions = this.remote.get(projectId);
    return { enabled: !!sessions, sessions: sessions ? [...sessions.values()] : [] };
  }

  private emitState(projectId: string) {
    this.host.emit({ event: "remote.updated", payload: { projectId, state: this.state(projectId) } });
  }

  /** Updates the remote entry of a session; with an empty patch it only refreshes the title. */
  update(sessionId: string, patch: Partial<RemoteSession>) {
    const rec = this.db.getSession(sessionId);
    const map = rec && this.remote.get(rec.projectId);
    if (!rec || !map) return;
    const cur: RemoteSession = map.get(sessionId) ?? { sessionId, title: rec.title ?? "", url: null, state: "connecting", message: null };
    map.set(sessionId, { ...cur, title: rec.title ?? "", ...patch });
    this.emitState(rec.projectId);
  }

  drop(sessionId: string) {
    const rec = this.db.getSession(sessionId);
    const map = rec && this.remote.get(rec.projectId);
    if (rec && map?.delete(sessionId)) this.emitState(rec.projectId);
  }

  /**
   * Switches Remote Control on for a project: every open FORGE session of the project is connected to
   * the Claude app, so messages show up on both sides and FORGE's approvals and policy keep applying.
   * Without an open session FORGE opens an empty one that can be started from the phone.
   */
  async start(projectId: string): Promise<RemoteState> {
    this.projects.requireExisting(projectId);
    if (!this.remote.has(projectId)) this.remote.set(projectId, new Map());
    const open = this.host.liveIds().filter((id) => this.db.getSession(id)?.projectId === projectId);
    if (open.length) await Promise.all(open.map((id) => this.bridge(id)));
    else await this.host.startEmpty(projectId);
    return this.state(projectId);
  }

  async stop(projectId: string): Promise<RemoteState> {
    const map = this.remote.get(projectId);
    this.remote.delete(projectId);
    for (const id of map?.keys() ?? []) {
      await this.host
        .live(id)
        ?.rt.setRemoteControl(false, "")
        .catch(() => {});
    }
    this.emitState(projectId);
    return this.state(projectId);
  }

  async bridge(sessionId: string) {
    const live = this.host.live(sessionId);
    const rec = this.db.getSession(sessionId);
    if (!live || !rec) return;
    const project = this.projects.get(rec.projectId);
    this.update(sessionId, { state: "connecting", message: null });
    const name = rec.title === REMOTE_PLACEHOLDER_TITLE ? `FORGE · ${project.name}` : `FORGE · ${project.name} · ${rec.title}`;
    try {
      const url = await live.rt.setRemoteControl(true, name.slice(0, 120));
      if (!this.remote.has(rec.projectId)) {
        // switched off while connecting
        await live.rt.setRemoteControl(false, name).catch(() => {});
        return;
      }
      this.update(sessionId, { url });
    } catch (e) {
      this.update(sessionId, { state: "error", message: describeRuntimeError(e) });
    }
  }

  /** Reason for an approval prompt that was aborted by the CLI. */
  abortReason(sessionId: string): string {
    return this.remote.has(this.db.getSession(sessionId)?.projectId ?? "") ? "In der Claude-App beantwortet oder abgebrochen" : "Abgebrochen";
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
