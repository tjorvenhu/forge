<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0015-crew-live-zusammenarbeit.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0015: Crew – several FORGE installations work live on one project

Date: 2026-10-22 · Status: accepted

## Goal

Two or more people work with FORGE on the same project at the same time, each on their own computer,
without worktrees. Their agents always know what the others' agents do, what is done and what is still
open, and can share work. That way more agent power runs in parallel, without duplicate work and without
conflicts.

## Decisions

**Relay instead of peer-to-peer.** Computers behind NAT cannot reach each other directly. A small relay keeps a numbered list of messages per room and hands them out as
server-sent events; writing is a POST. No WebSocket: Node has no built-in server for it, while SSE and
`fetch` run without packages on both sides and through any proxy. The relay keeps the newest messages for a
while, so a member catches up after a break.

**Relay inside the website.** The relay is part of the FORGE website (`services/stats`, Next.js, routes
`/crew/v1/rooms/<room>` and `/crew/v1/rooms/<room>/stream`, core in `lib/crew-relay.ts` without framework
code). It runs in the same container as the website: no domain, resource or deployment of its own. Next
bundles every route separately, so the one relay of the process lives on `globalThis`. The stream says
`Cache-Control: no-transform`, so the proxy in front does not compress and buffer it. The relay needs no
database; it also works while Postgres is down.

**End-to-end encrypted.** Everything in the room is sealed with the crew key (AES-256-GCM, room and key id
as AAD). The relay only sees the room, a sender id and encrypted bytes.

**Joining with an invite and approval.** The invite code (`forge-crew1.…`, also as a QR code) holds the
relay, the room, an invite key of its own, the expiry (24 h) and crew, project and origin for a preview. It
only allows asking to join. The request carries the newcomer's X25519 key; a member lets them in and sends
the crew key sealed with the shared key from X25519 and HKDF. Both sides show the same check code
(fingerprint of the key), so it can be compared on the phone or in chat before accepting. Whoever only read
the code does not get the crew key. A new code makes the old one invalid.

**Removing with a new key.** Only the one who started the crew removes members. That makes a new crew key,
sealed for each remaining member. The removed member only reads that it is out.

**Everyone has the whole state.** No server state: every member keeps members, tasks (the newest by
`updatedAt` wins, deleted ones stay as tombstones), feed and presence itself (`<data folder>/crew/<id>.json`;
the keys are in the secret store and never in backups or the GitHub sync). A `hello` after connecting is
answered with the whole state, so a relay restart does no harm.

**Project by origin, code by git.** A project belongs to the crew when its origin points to the same
repository (`remoteIdentity`: host/owner/repo, https and ssh alike). Code does not travel over the relay but
over git: FORGE notices its own pushes (commits of its own git identity on `origin/<branch>`) and reports
them to the crew. The others fetch them and, if wanted, take them over on their own (`autoPull`, on by
default) while no session works in their project. This uses the existing `GitEngine.pull` (rebase,
uncommitted work into the stash and back, conflicts abort).

**What agents learn.** Three ways, all in `crew/crew-service.ts` and `crew/session-tools.ts`:

1. Start context and the tools `crew_status`, `crew_task` and `crew_message` (all without asking).
2. News (messages, tasks, finished requests, pushes, overlaps) as a note with the next message
   (`TurnHost.note`) and live after tool calls (PostToolUse hook with `additionalContext`).
3. Before every Edit/Write on a file that is in work at another member, a warning (PreToolUse hook with
   `additionalContext`, once per session and file in 10 minutes).

**What everyone shares (presence).** Branch, unpushed files (working tree and own commits), the number of
unpushed commits and per session: title, status, current request, files changed in the turn and last
result. Finished turns go into the feed. Prompts and results thus reach the crew members. That is the
purpose, and the interface says so.

**More agent power.** Tasks have an assignee. When a member gets one, its FORGE starts a session for it on
its own depending on the setting (`acceptTasks`: auto, ask, off); its successful end marks the task done.

**Crew in the browser (addendum 2026-10-23).** Whoever is away from the computer follows the crew on the
website (`/crew`, also on a phone). The invite link (`https://forge.vanturis.de/crew#<code>`, also in the QR
code) opens it; FORGE takes the same link as a code. The browser is a member of its own with its own X25519
key (flag `web` on the member card) and gets in like any installation, only after the check code. On purpose
no access through a shared crew key without approval: it could not be shut out when removed. The browser
reads chat, people, tasks and join requests, writes messages and tasks, lets others in and watches a session
live (`share_ask` with `events`: only the newest 400 events; older FORGE versions ignore the field and send
everything). It has no sessions and declines requests for them. Keys and state live in this browser's
`localStorage`.

## Consequences

- The website has to run with these routes (deployed in Coolify), otherwise every crew stays offline. Own
  relays are possible (relay URL in the crew profile).
- The relay keeps its rooms in the memory of the website process: a redeploy forgets them, the members
  exchange their state again. With several website replicas the relay would split; the website runs as one.
- At most 8 members per crew: everyone answers a `hello` with the whole state.
- The sender id in the room is not signed. All members know the crew key and trust each other; only removing
  and the founder flag are protected against other members.
