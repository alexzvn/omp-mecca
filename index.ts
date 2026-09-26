import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { basename } from "node:path";
import {
  HEARTBEAT_MS,
  MAX_CONTENT_BYTES,
  MAX_DEPTH,
  type MailboxRow,
  type MessageKind,
  type MessageMode,
  type MessageRow,
  type Policy,
  type SessionRow,
  type Store,
  openStore,
} from "./store.ts";

type Status = "idle" | "working";

interface Ctx {
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  setInterval(fn: () => void, ms: number): unknown;
}

interface DialogUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
}

interface Theme {
  fg(color: string, text: string): string;
}

interface MeccaDetails {
  id: string;
  kind: MessageKind;
  sender: string;
  senderTitle: string;
  title: string;
  content: string;
  depth: number;
  /** Absent on messages persisted before modes existed. */
  mode?: MessageMode;
}

const TICK_MS = 1000;
const HEARTBEAT_EVERY = Math.max(1, Math.round(HEARTBEAT_MS / TICK_MS));
const PRUNE_EVERY = 60;
const CUSTOM_TYPE = "mecca.message";

const GUIDE = `mecca: message other live omp sessions on this machine. Ids are 7 chars.
read  mecca://sessions[?page=N]         id · title · dir · status · intent, 20/page
read  mecca://session/count | /<id>
read  mecca://mailbox[?page=N&unread]   page 1 = latest
read  mecca://mailbox/<msgId> | /policy
write mecca://mailbox                   broadcast; recipients see it next turn
write mecca://mailbox/<sessionId>       direct; wakes an idle recipient
write mecca://mailbox/policy            on | off | {"global":bool,"direct":bool,"urgent":bool}
Message content: first line = title, rest = body (≤${MAX_CONTENT_BYTES} B); or {"title","content","mode"}.
mode: "normal" (default) waits until a working recipient ends its run; "urgent" interrupts a direct recipient's run now.
An urgent broadcast is handled like a regular direct message: it wakes idle recipients but never interrupts.
Use urgent only when the recipient must act before finishing its current work.
Reply only if asked. Reply chains past depth ${MAX_DEPTH} are rejected.
Incoming messages are pushed into your session: the harness wakes you when a direct message arrives, and broadcasts land on your next turn.
NEVER poll: do not loop sleep + read mecca://mailbox waiting for a reply. After sending, end your turn or continue other work.`;

const DESCRIPTION =
  "Message other live omp sessions. Read mecca://guide first for paths and formats. Replies are pushed to you (harness wakes this session); never poll with sleep + read mecca://mailbox.";

function intentFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("i" in value)) return undefined;
  const i = value.i;
  return typeof i === "string" && i.trim() !== "" ? i.trim() : undefined;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseMessage(raw: string): { title: string; content: string; mode: MessageMode } {
  const json = parseJson(raw);
  let title: string;
  let content: string;
  let mode: MessageMode = "normal";
  if (
    typeof json === "object" &&
    json !== null &&
    "title" in json &&
    typeof json.title === "string" &&
    (!("content" in json) || typeof json.content === "string")
  ) {
    title = json.title.trim();
    content = "content" in json && typeof json.content === "string" ? json.content : "";
    if ("mode" in json && json.mode !== undefined) {
      if (json.mode !== "normal" && json.mode !== "urgent") {
        throw new Error(`mecca: mode must be "normal" or "urgent", got ${JSON.stringify(json.mode)}`);
      }
      mode = json.mode;
    }
  } else {
    const newline = raw.indexOf("\n");
    const first = newline === -1 ? raw : raw.slice(0, newline);
    title = first.replace(/^[\s#]+/, "").trim();
    content = newline === -1 ? "" : raw.slice(newline + 1).trim();
  }
  if (title === "") throw new Error("mecca: message title is empty");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(`mecca: content is ${bytes} bytes; limit is ${MAX_CONTENT_BYTES}`);
  }
  return { title, content, mode };
}

const POLICY_ERROR =
  'mecca: policy content must be "on", "off", or JSON like {"global": false, "direct": true, "urgent": false}';

function parsePolicy(raw: string): Partial<Policy> {
  const text = raw.trim();
  if (text === "on") return { global: true, direct: true, urgent: true };
  if (text === "off") return { global: false, direct: false, urgent: false };
  const json = parseJson(text);
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(POLICY_ERROR);
  const patch: Partial<Policy> = {};
  for (const [key, value] of Object.entries(json)) {
    if ((key !== "global" && key !== "direct" && key !== "urgent") || typeof value !== "boolean") {
      throw new Error(POLICY_ERROR);
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw new Error(POLICY_ERROR);
  return patch;
}

function formatPolicy(policy: Policy): string {
  const onOff = (v: boolean) => (v ? "on" : "off");
  return `global: ${onOff(policy.global)}\ndirect: ${onOff(policy.direct)}\nurgent: ${onOff(policy.urgent)}`;
}

function parsePath(raw: string): { segments: string[]; page: number; unread: boolean } {
  let rest = raw.trim();
  if (rest.startsWith("mecca://")) rest = rest.slice("mecca://".length);
  let page = 1;
  let unread = false;
  const q = rest.indexOf("?");
  if (q !== -1) {
    const params = new URLSearchParams(rest.slice(q + 1));
    rest = rest.slice(0, q);
    const pageParam = params.get("page");
    if (pageParam !== null) {
      if (!/^\d+$/.test(pageParam) || Number(pageParam) < 1) {
        throw new Error(`mecca: page must be an integer >= 1, got "${pageParam}"`);
      }
      page = Number(pageParam);
    }
    const unreadParam = params.get("unread");
    unread = unreadParam !== null && unreadParam !== "0" && unreadParam !== "false";
  }
  rest = rest.replace(/^\/+|\/+$/g, "");
  const segments = rest === "" ? [] : rest.split("/");
  if (segments[0] === "session") segments[0] = "sessions";
  return { segments, page, unread };
}

function loopGuardNote(depth: number): string | undefined {
  if (depth < MAX_DEPTH) return undefined;
  return `loop guard: depth ${depth}/${MAX_DEPTH}; a direct reply will be rejected.`;
}

/** Hard-wraps plain text into lines of at most `width` terminal cells, each prefixed by `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const room = Math.max(1, width - Bun.stringWidth(indent));
  const out: string[] = [];
  let line = "";
  let used = 0;
  for (const ch of text.replace(/\t/g, "  ")) {
    const w = Bun.stringWidth(ch);
    if (used + w > room) {
      out.push(indent + line);
      line = "";
      used = 0;
    }
    line += ch;
    used += w;
  }
  out.push(indent + line);
  return out;
}

/** Truncates plain text to `width` terminal cells. */
function fit(text: string, width: number): string {
  const clean = text.replace(/\t/g, "  ").replace(/[\r\n]+/g, " ");
  if (Bun.stringWidth(clean) <= width) return clean;
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const w = Bun.stringWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function detailsOf(value: unknown): MeccaDetails | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "kind" in value &&
    (value.kind === "global" || value.kind === "direct") &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "senderTitle" in value &&
    typeof value.senderTitle === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "depth" in value &&
    typeof value.depth === "number" &&
    (!("mode" in value) || value.mode === undefined || value.mode === "normal" || value.mode === "urgent")
  ) {
    return {
      id: value.id,
      kind: value.kind,
      sender: value.sender,
      senderTitle: value.senderTitle,
      title: value.title,
      content: value.content,
      depth: value.depth,
      mode: "mode" in value ? value.mode : undefined,
    };
  }
  return undefined;
}

export default function mecca(pi: ExtensionAPI): void {
  const z = pi.zod;

  let store: Store | undefined;
  let meId: string | undefined;
  let cursor = 0;
  let ticks = 0;
  let lastIntent = "";
  let status: Status = "idle";
  let liveCtx: Ctx | undefined;
  /** Deepest mecca direct message delivered into the current agent run; undefined when the run is user-driven only. */
  let turnDepth: number | undefined;
  /** Non-urgent arrivals held while this session is working; flushed with a banner when the run ends. */
  const held: MessageRow[] = [];

  const titleOf = (): string => {
    const name = pi.getSessionName();
    return typeof name === "string" ? name.trim() : "";
  };

  const labelOf = (row: Pick<SessionRow, "title" | "cwd">): string => row.title || basename(row.cwd);

  const liveRow = <T extends SessionRow>(row: T): T => {
    if (row.id !== meId || !liveCtx) return row;
    return { ...row, title: titleOf(), cwd: liveCtx.cwd, intent: lastIntent, status };
  };

  const senderLabel = (s: Store, id: string): string => {
    const row = s.getSession(id);
    return `${id} (${row ? labelOf(liveRow(row)) : "unknown"})`;
  };

  const outgoingDepth = (): number => (turnDepth === undefined ? 0 : turnDepth + 1);

  const formatMessage = (s: Store, m: MailboxRow): string => {
    const lines = [
      `id: ${m.id}${m.unread ? " (unread)" : ""}`,
      `type: ${m.kind}`,
      `title: ${m.title}`,
      `sender: ${senderLabel(s, m.sender)}`,
    ];
    if (m.kind === "direct" && m.recipient) lines.push(`to: ${senderLabel(s, m.recipient)}`);
    lines.push(`created: ${new Date(m.created_at).toISOString()}`);
    if (m.depth > 0) lines.push(`depth: ${m.depth}`);
    if (m.mode === "urgent") lines.push("mode: urgent");
    lines.push("content:");
    lines.push(m.content);
    return lines.join("\n");
  };

  /** Injects a message into the session: `steer` interrupts the run (or starts one), `aside` joins the next step (or wakes), `nextTurn` waits for the next prompt. */
  const present = (
    s: Store,
    me: string,
    ctx: Ctx,
    row: MessageRow,
    deliverAs: "steer" | "aside" | "nextTurn",
    toast: boolean,
  ): void => {
    const senderTitle = (() => {
      const r = s.getSession(row.sender);
      return r ? labelOf(r) : "unknown";
    })();
    const urgent = row.mode === "urgent" ? " urgent" : "";
    if (toast) ctx.ui.notify(`mecca${urgent} ${row.kind} from ${row.sender} (${senderTitle}): ${row.title}`, "info");
    const guard = loopGuardNote(row.depth);
    const text = [
      `[mecca${urgent} ${row.kind} ${row.id} from ${row.sender} (${senderTitle})] ${row.title}`,
      row.content,
      guard ?? "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const details: MeccaDetails = {
      id: row.id,
      kind: row.kind,
      sender: row.sender,
      senderTitle,
      title: row.title,
      content: row.content,
      depth: row.depth,
      mode: row.mode,
    };
    if (row.kind === "direct") turnDepth = Math.max(turnDepth ?? 0, row.depth);
    pi.sendMessage(
      { customType: CUSTOM_TYPE, content: text, display: true, details },
      deliverAs === "steer" ? { deliverAs, triggerTurn: true } : { deliverAs },
    );
    s.markRead(me, [row.seq]);
  };

  const deliver = (s: Store, me: string, ctx: Ctx, row: MessageRow): void => {
    const policy = s.getPolicy(me);
    if (!policy[row.kind]) return;
    if (row.kind === "direct" && row.mode === "urgent" && policy.urgent) {
      present(s, me, ctx, row, "steer", true);
      return;
    }
    if (status === "working") {
      held.push(row);
      return;
    }
    // An urgent broadcast is treated as a regular direct message: it wakes an idle session but never interrupts.
    const wakes = row.kind === "direct" || row.mode === "urgent";
    present(s, me, ctx, row, wakes ? "aside" : "nextTurn", true);
  };

  /** Hands messages held during the finished run to the next prompt and tells the user about them. */
  const flushHeld = (): void => {
    const s = store;
    const me = meId;
    const ctx = liveCtx;
    if (!s || !me || !ctx || held.length === 0) return;
    const rows = held.splice(0);
    ctx.ui.notify(`you have ${rows.length} message${rows.length === 1 ? "" : "s"} from mecca`, "info");
    for (const row of rows) present(s, me, ctx, row, "nextTurn", false);
  };

  const beat = (): void => {
    if (!store || !meId || !liveCtx) return;
    store.heartbeat(meId, { title: titleOf(), cwd: liveCtx.cwd, intent: lastIntent, status });
  };

  const tick = (): void => {
    const s = store;
    const me = meId;
    const ctx = liveCtx;
    if (!s || !me || !ctx) return;
    ticks++;
    if (ticks % HEARTBEAT_EVERY === 0) beat();
    if (ticks % PRUNE_EVERY === 0) s.prune();
    for (const row of s.pollNew(me, cursor)) {
      cursor = row.seq;
      deliver(s, me, ctx, row);
    }
  };

  const announceUnread = (s: Store, me: string, ctx: Ctx): void => {
    const unread = s.unreadCount(me);
    if (unread > 0) {
      ctx.ui.notify(`mecca: ${unread} unread (mecca://mailbox?unread or /mecca inbox)`, "info");
    }
  };

  const activate = (ctx: Ctx): void => {
    if (ctx.hasUI !== true) return;
    const ompSessionId = ctx.sessionManager.getSessionId();
    const s = (store ??= openStore());
    const first = meId === undefined;
    liveCtx = ctx;
    if (meId) {
      if (s.getSession(meId)?.omp_session_id === ompSessionId) return;
      s.markOffline(meId);
    }
    turnDepth = undefined;
    held.length = 0;
    lastIntent = "";
    meId = s.claim({ ompSessionId, pid: process.pid, cwd: ctx.cwd, title: titleOf() });
    s.prune();
    if (first) {
      cursor = s.maxSeq();
      ctx.setInterval(tick, TICK_MS);
    }
    announceUnread(s, meId, ctx);
  };

  pi.on("session_start", (_event, ctx) => activate(ctx));
  pi.on("session_switch", (_event, ctx) => activate(ctx));

  pi.on("session_shutdown", () => {
    if (store && meId) store.markOffline(meId);
    meId = undefined;
    liveCtx = undefined;
  });

  // omp strips the `i` argument before execution and exposes it as `intent` on tool_execution_start.
  pi.on("tool_execution_start", (event) => {
    const intent = "intent" in event && typeof event.intent === "string" ? event.intent.trim() : "";
    lastIntent = intent || intentFrom("args" in event ? event.args : undefined) || event.toolName;
  });

  pi.on("agent_start", () => {
    status = "working";
    beat();
  });

  pi.on("agent_end", (event) => {
    if ("willContinue" in event && event.willContinue === true) return;
    status = "idle";
    turnDepth = undefined;
    beat();
    flushHeld();
  });

  // ---- tool ----

  const readSessions = (s: Store, page: number): string => {
    const { rows, total, pages } = s.listActive(page);
    if (total === 0) return "No active sessions.";
    if (page > pages) throw new Error(`mecca: page ${page} out of range (1..${pages})`);
    const lines = [`sessions page ${page}/${pages} · ${total} active`];
    for (const raw of rows) {
      const r = liveRow(raw);
      const you = r.id === meId ? " (you)" : "";
      lines.push(`${r.id} · ${r.title || "(untitled)"} · ${basename(r.cwd)} · ${r.status} · ${r.intent || "—"}${you}`);
    }
    return lines.join("\n");
  };

  const readSession = (s: Store, id: string): string => {
    const info = s.getSession(id);
    if (!info) throw new Error(`mecca: session ${id} not found`);
    const r = liveRow(info);
    return [
      `id: ${r.id}`,
      `title: ${r.title || "(untitled)"}`,
      `intent: ${r.intent || "—"}`,
      `status: ${r.status}`,
      `cwd: ${r.cwd}`,
      `omp session: ${r.omp_session_id}`,
      `pid: ${r.pid}`,
      `started: ${new Date(r.started_at).toISOString()}`,
      `last seen: ${Math.round((Date.now() - r.last_seen) / 1000)}s ago`,
      `active: ${r.active}`,
    ].join("\n");
  };

  const readMailbox = (s: Store, me: string, page: number, unreadOnly: boolean): string => {
    const unread = s.unreadCount(me);
    const { rows, total, pages } = s.listVisible(me, page, unreadOnly);
    if (total === 0) return unreadOnly ? "No unread messages." : "Mailbox empty.";
    if (page > pages) throw new Error(`mecca: page ${page} out of range (1..${pages})`);
    const scope = unreadOnly ? "unread messages" : `messages · ${unread} unread`;
    const header = `mailbox page ${page}/${pages} · ${total} ${scope} (page 1 = latest)`;
    s.markRead(me, rows.filter((m) => m.unread).map((m) => m.seq));
    return [header, ...rows.map((m) => formatMessage(s, m))].join("\n\n");
  };

  const send = (s: Store, me: string, target: string | undefined, raw: string, depth: number): string => {
    const msg = parseMessage(raw);
    if (target === undefined) {
      // Broadcasts keep their mode; recipients treat an urgent broadcast as a regular direct message.
      const row = s.postMessage({ kind: "global", sender: me, recipient: null, depth, ...msg });
      return `sent ${row.id} (global${msg.mode === "urgent" ? ", urgent" : ""})`;
    }
    if (target === me) throw new Error("mecca: cannot direct-message yourself");
    if (!s.isActive(target)) throw new Error(`mecca: session ${target} not active`);
    if (depth > MAX_DEPTH) {
      throw new Error(
        `mecca: loop guard: depth ${depth} > ${MAX_DEPTH}; not sent.`,
      );
    }
    const row = s.postMessage({ kind: "direct", sender: me, recipient: target, depth, ...msg });
    const guard = loopGuardNote(depth);
    const sent = `sent ${row.id} (direct${msg.mode === "urgent" ? ", urgent" : ""} → ${target})`;
    return guard ? `${sent}\nloop guard: depth ${depth}/${MAX_DEPTH}; recipient cannot direct-reply.` : sent;
  };

  const unknownPath = (path: string): never => {
    throw new Error(`mecca: unknown path: ${path}. Read mecca://guide`);
  };

  const route = (op: "read" | "write", rawPath: string, content: string | undefined): string => {
    if (op === "read" && parsePath(rawPath).segments.join("/") === "guide") return GUIDE;
    const s = store;
    const me = meId;
    if (!s || !me) throw new Error("mecca: this session is not registered (headless/subagent)");
    const { segments, page, unread } = parsePath(rawPath);
    const [head, arg, extra] = segments;
    if (extra !== undefined) return unknownPath(rawPath);

    if (op === "read") {
      if (head === "sessions" && arg === undefined) return readSessions(s, page);
      if (head === "sessions" && arg === "count") return String(s.countActive());
      if (head === "sessions" && arg !== undefined) return readSession(s, arg);
      if (head === "mailbox" && arg === undefined) return readMailbox(s, me, page, unread);
      if (head === "mailbox" && arg === "policy") return formatPolicy(s.getPolicy(me));
      if (head === "mailbox" && arg !== undefined) {
        const m = s.getMessage(me, arg);
        if (!m) throw new Error(`mecca: message ${arg} not found`);
        if (m.unread) s.markRead(me, [m.seq]);
        return formatMessage(s, m);
      }
      return unknownPath(rawPath);
    }

    if (head !== "mailbox") return unknownPath(rawPath);
    if (content === undefined) throw new Error("mecca: content is required for op=write");
    if (arg === "policy") return formatPolicy(s.setPolicy(me, parsePolicy(content)));
    return send(s, me, arg, content, outgoingDepth());
  };

  pi.registerTool({
    name: "mecca",
    label: "Mecca",
    description: DESCRIPTION,
    loadMode: "essential",
    parameters: z.object({
      op: z.enum(["read", "write"]),
      path: z.string().describe("mecca:// URL"),
      content: z.string().optional().describe("write body"),
    }),
    approval: (args: { op: "read" | "write" }) => (args.op === "read" ? "read" : "write"),
    async execute(_toolCallId, params) {
      const text = route(params.op, params.path, params.content);
      return { content: [{ type: "text", text }], details: { path: params.path, op: params.op } };
    },
  });

  // ---- TUI rendering of delivered messages ----

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme: Theme) => {
    const d = detailsOf("details" in message ? message.details : undefined);
    let cacheWidth = -1;
    let cache: readonly string[] = [];
    return {
      render(width: number): readonly string[] {
        if (width === cacheWidth) return cache;
        const w = Math.max(10, width);
        const lines: string[] = [];
        if (!d) {
          const text = typeof message.content === "string" ? message.content : "";
          for (const line of text.split("\n")) lines.push(fit(line, w));
        } else {
          const label = `✉ mecca${d.mode === "urgent" ? " urgent" : ""} ${d.kind}`;
          const from = ` ${d.sender} (${d.senderTitle}) · `;
          const head = fit(`${label}${from}${d.title}`, w);
          lines.push(
            theme.fg("customMessageLabel", head.slice(0, label.length)) + head.slice(label.length),
          );
          const guard = loopGuardNote(d.depth);
          const layout = (text: string) => (expanded ? wrap(text, w, "  ") : [fit(`  ${text}`, w)]);
          if (guard) for (const line of layout(guard)) lines.push(theme.fg("warning", line));
          const body = d.content.split("\n");
          const shown = expanded ? body : body.slice(0, 1);
          for (const text of shown) {
            if (text === "") continue;
            for (const line of layout(text)) lines.push(theme.fg("muted", line));
          }
          if (!expanded && body.length > 1) lines.push(theme.fg("dim", fit(`  … ${body.length - 1} more lines`, w)));
        }
        cacheWidth = width;
        cache = lines;
        return cache;
      },
      invalidate() {
        cacheWidth = -1;
      },
    };
  });

  // ---- /mecca command ----

  const pick = async <T>(ui: DialogUi, title: string, items: readonly T[], label: (item: T) => string) => {
    const labels = items.map(label);
    const chosen = await ui.select(title, labels);
    if (chosen === undefined) return undefined;
    const index = labels.indexOf(chosen);
    return index === -1 ? undefined : items[index];
  };

  const compose = async (ui: DialogUi, s: Store, me: string, target: string | undefined): Promise<void> => {
    const title = await ui.input(target ? `Message to ${senderLabel(s, target)}: title` : "Broadcast: title");
    if (title === undefined || title.trim() === "") return;
    const body = (await ui.editor("Message body (optional)", "")) ?? "";
    try {
      // Human-sent messages start a fresh reply chain.
      const result = send(s, me, target, JSON.stringify({ title, content: body.trim() }), 0);
      ui.notify(`mecca: ${result}`, "info");
    } catch (err) {
      ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const openInbox = async (ui: DialogUi, s: Store, me: string, unreadOnly: boolean): Promise<void> => {
    const { rows } = s.listVisible(me, 1, unreadOnly);
    if (rows.length === 0) {
      ui.notify(unreadOnly ? "mecca: no unread messages" : "mecca: mailbox empty", "info");
      return;
    }
    const newestFirst = [...rows].reverse();
    const m = await pick(ui, "mecca mailbox (● unread)", newestFirst, (row) => {
      const mark = row.unread ? "●" : " ";
      const dir = row.sender === me ? `→ ${row.recipient ?? "all"}` : `← ${senderLabel(s, row.sender)}`;
      return `${mark} ${row.id} · ${row.kind} ${dir} · ${row.title}`;
    });
    if (!m) return;
    if (m.unread) s.markRead(me, [m.seq]);
    const canReply = m.sender !== me && s.isActive(m.sender);
    const body = `${formatMessage(s, { ...m, unread: 0 })}${canReply ? "\n\nReply?" : ""}`;
    const reply = await ui.confirm(`mecca ${m.kind} · ${m.title}`, body);
    if (reply && canReply) await compose(ui, s, me, m.sender);
  };

  const openSessions = async (ui: DialogUi, s: Store, me: string): Promise<void> => {
    const others = s.listActive(1).rows.filter((r) => r.id !== me);
    if (others.length === 0) {
      ui.notify("mecca: no other active sessions", "info");
      return;
    }
    const target = await pick(ui, "mecca sessions · pick one to message", others, (r) =>
      `${r.id} · ${r.title || "(untitled)"} · ${basename(r.cwd)} · ${r.status} · ${r.intent || "—"}`,
    );
    if (target) await compose(ui, s, me, target.id);
  };

  const SUBCOMMANDS = ["sessions", "inbox", "unread", "send", "broadcast", "policy"];

  pi.registerCommand("mecca", {
    description: "Mecca hub: sessions | inbox | unread | send [id] | broadcast | policy [on|off]",
    getArgumentCompletions(prefix) {
      const p = prefix.trim().toLowerCase();
      return SUBCOMMANDS.filter((c) => c.startsWith(p)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const ui: DialogUi = ctx.ui;
      const s = store;
      const me = meId;
      if (!s || !me) {
        ui.notify("mecca: this session is not registered (headless/subagent)", "error");
        return;
      }
      const [sub = "sessions", arg] = args.trim().split(/\s+/).filter((part) => part !== "");
      switch (sub) {
        case "sessions":
          return openSessions(ui, s, me);
        case "inbox":
          return openInbox(ui, s, me, false);
        case "unread":
          return openInbox(ui, s, me, true);
        case "broadcast":
          return compose(ui, s, me, undefined);
        case "send": {
          if (arg) return compose(ui, s, me, arg);
          return openSessions(ui, s, me);
        }
        case "policy": {
          try {
            const policy = arg ? s.setPolicy(me, parsePolicy(arg)) : s.getPolicy(me);
            ui.notify(`mecca policy · ${formatPolicy(policy).replaceAll("\n", " · ")}`, "info");
          } catch (err) {
            ui.notify(err instanceof Error ? err.message : String(err), "error");
          }
          return;
        }
        default:
          ui.notify(`Usage: /mecca [${SUBCOMMANDS.join("|")}]`, "error");
      }
    },
  });
}
