import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PAGE_SIZE = 20;
export const HEARTBEAT_MS = 5000;
export const STALE_MS = 15_000;
/** Offline rows are kept this long so a resumed omp session reclaims its mecca id. */
export const RETAIN_MS = 24 * 3_600_000;
export const MAX_CONTENT_BYTES = 16_384;
export const MESSAGE_TTL_MS = 7 * 86_400_000;
/** Reply-chain depth that is still delivered, with a loop-guard warning. Deeper direct messages are rejected. */
export const MAX_DEPTH = 256;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ID_ATTEMPTS = 5;
const VISIBLE = "(m.kind = 'global' OR m.recipient = ?1 OR (m.kind = 'direct' AND m.sender = ?1))";
const UNREAD =
  "(m.sender != ?1 AND m.seq > (SELECT joined_seq FROM sessions WHERE id = ?1)" +
  " AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.session = ?1 AND r.seq = m.seq))";

export type MessageKind = "global" | "direct";
/** `urgent` (direct only) interrupts the recipient's current run instead of waiting for it to end. */
export type MessageMode = "normal" | "urgent";

export interface SessionRow {
  id: string;
  omp_session_id: string;
  pid: number;
  cwd: string;
  title: string;
  intent: string;
  status: string;
  notify_global: number;
  notify_direct: number;
  notify_urgent: number;
  joined_seq: number;
  started_at: number;
  last_seen: number;
}

export interface SessionInfo extends SessionRow {
  active: boolean;
}

export interface MessageRow {
  seq: number;
  id: string;
  kind: MessageKind;
  sender: string;
  recipient: string | null;
  title: string;
  content: string;
  depth: number;
  mode: MessageMode;
  created_at: number;
}

export interface MailboxRow extends MessageRow {
  unread: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  pages: number;
}

export interface Policy {
  global: boolean;
  direct: boolean;
  /** When false, urgent direct messages are queued like normal ones. */
  urgent: boolean;
}

export interface SessionPatch {
  ompSessionId?: string;
  title?: string;
  cwd?: string;
  intent?: string;
  status?: string;
}

export function nanoid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte & 63];
  return id;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message);
}

function withFreshId<T>(insert: (id: string) => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return insert(nanoid());
    } catch (err) {
      if (attempt >= ID_ATTEMPTS || !isUniqueViolation(err)) throw err;
    }
  }
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

const WAL_ATTEMPTS = 40;

/**
 * Switching a fresh DB to WAL needs an exclusive lock and can fail with SQLITE_BUSY without
 * consulting busy_timeout, so concurrent first opens retry with jitter.
 */
function enableWal(db: Database): void {
  for (let attempt = 1; ; attempt++) {
    try {
      const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
      if (row?.journal_mode === "wal") return;
      throw new Error(`mecca: could not enable WAL (journal_mode=${row?.journal_mode})`);
    } catch (err) {
      const busy = err instanceof Error && "code" in err && err.code === "SQLITE_BUSY";
      if (!busy || attempt >= WAL_ATTEMPTS) throw err;
      Bun.sleepSync(10 + Math.random() * 40);
    }
  }
}

/** Adds a column to a table created by an older mecca version; no-op when it already exists. */
function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // A concurrent open may have migrated first.
    if (!(err instanceof Error && /duplicate column/i.test(err.message))) throw err;
  }
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout=3000;");
    enableWal(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        omp_session_id TEXT,
        pid INTEGER,
        cwd TEXT,
        title TEXT NOT NULL DEFAULT '',
        intent TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        notify_global INTEGER NOT NULL DEFAULT 1,
        notify_direct INTEGER NOT NULL DEFAULT 1,
        notify_urgent INTEGER NOT NULL DEFAULT 1,
        joined_seq INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        last_seen INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_omp ON sessions(omp_session_id);
      CREATE TABLE IF NOT EXISTS messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('global','direct')),
        sender TEXT NOT NULL,
        recipient TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'normal',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts(
        session TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY(session, seq)
      ) WITHOUT ROWID;
    `);
    ensureColumn(this.db, "sessions", "notify_urgent", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(this.db, "messages", "mode", "TEXT NOT NULL DEFAULT 'normal'");
  }

  /**
   * Returns the mecca id for an omp session: the retained id of an offline row with the same
   * omp session id (resume), else a fresh one.
   */
  claim(info: { ompSessionId: string; pid: number; cwd: string; title: string }): string {
    const now = Date.now();
    const retained = this.db
      .query<{ id: string }, [string, number]>(
        `SELECT id FROM sessions WHERE omp_session_id = ?
           AND (status = 'offline' OR last_seen < ?) ORDER BY last_seen DESC LIMIT 1`,
      )
      .get(info.ompSessionId, now - STALE_MS);
    if (retained) {
      this.db
        .query(
          `UPDATE sessions SET pid = ?, cwd = ?, title = ?, intent = '', status = 'idle', last_seen = ?
           WHERE id = ?`,
        )
        .run(info.pid, info.cwd, info.title, now, retained.id);
      return retained.id;
    }
    const joined = this.maxSeq();
    return withFreshId((id) => {
      this.db
        .query(
          `INSERT INTO sessions(id, omp_session_id, pid, cwd, title, joined_seq, started_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, info.ompSessionId, info.pid, info.cwd, info.title, joined, now, now);
      return id;
    });
  }

  heartbeat(id: string, patch: SessionPatch = {}): void {
    const now = Date.now();
    const sets = ["last_seen = ?"];
    const values: (string | number)[] = [now];
    const columns: [keyof SessionPatch, string][] = [
      ["ompSessionId", "omp_session_id"],
      ["title", "title"],
      ["cwd", "cwd"],
      ["intent", "intent"],
      ["status", "status"],
    ];
    for (const [key, column] of columns) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Deletes offline rows past retention, expired messages and orphaned receipts. */
  prune(): void {
    const now = Date.now();
    this.db.query("DELETE FROM sessions WHERE last_seen < ?").run(now - RETAIN_MS);
    this.db.query("DELETE FROM messages WHERE created_at < ?").run(now - MESSAGE_TTL_MS);
    this.db.exec(
      `DELETE FROM receipts WHERE session NOT IN (SELECT id FROM sessions)
         OR seq NOT IN (SELECT seq FROM messages)`,
    );
  }

  markOffline(id: string): void {
    this.db.query("UPDATE sessions SET status = 'offline', last_seen = ? WHERE id = ?").run(Date.now(), id);
  }

  countActive(): number {
    const row = this.db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM sessions WHERE status != 'offline' AND last_seen >= ?",
      )
      .get(Date.now() - STALE_MS);
    return row?.n ?? 0;
  }

  listActive(page: number): Page<SessionRow> {
    const total = this.countActive();
    const rows = this.db
      .query<SessionRow, [number, number, number]>(
        `SELECT * FROM sessions WHERE status != 'offline' AND last_seen >= ?
           ORDER BY started_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(Date.now() - STALE_MS, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return { rows, total, pages: pageCount(total) };
  }

  getSession(id: string): SessionInfo | undefined {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return undefined;
    return { ...row, active: row.status !== "offline" && row.last_seen >= Date.now() - STALE_MS };
  }

  isActive(id: string): boolean {
    return this.getSession(id)?.active === true;
  }

  postMessage(msg: {
    kind: MessageKind;
    sender: string;
    recipient: string | null;
    title: string;
    content: string;
    depth: number;
    mode: MessageMode;
  }): MessageRow {
    const now = Date.now();
    return withFreshId((id) => {
      const row = this.db
        .query<MessageRow, [string, string, string, string | null, string, string, number, string, number]>(
          `INSERT INTO messages(id, kind, sender, recipient, title, content, depth, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(id, msg.kind, msg.sender, msg.recipient, msg.title, msg.content, msg.depth, msg.mode, now);
      if (!row) throw new Error("mecca: message insert returned no row");
      return row;
    });
  }

  /** Page 1 is the newest PAGE_SIZE messages; rows within a page are oldest first. */
  listVisible(me: string, page: number, unreadOnly = false): Page<MailboxRow> {
    const where = unreadOnly ? `${VISIBLE} AND ${UNREAD}` : VISIBLE;
    const count = this.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`)
      .get(me);
    const total = count?.n ?? 0;
    const rows = this.db
      .query<MailboxRow, [string, number, number]>(
        `SELECT m.*, ${UNREAD} AS unread FROM messages m WHERE ${where}
           ORDER BY m.seq DESC LIMIT ?2 OFFSET ?3`,
      )
      .all(me, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .reverse();
    return { rows, total, pages: pageCount(total) };
  }

  unreadCount(me: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM messages m WHERE ${VISIBLE} AND ${UNREAD}`)
      .get(me);
    return row?.n ?? 0;
  }

  getMessage(me: string, msgId: string): MailboxRow | undefined {
    const row = this.db
      .query<MailboxRow, [string, string]>(
        `SELECT m.*, ${UNREAD} AS unread FROM messages m WHERE m.id = ?2 AND ${VISIBLE}`,
      )
      .get(me, msgId);
    return row ?? undefined;
  }

  markRead(me: string, seqs: readonly number[]): void {
    const insert = this.db.query("INSERT OR IGNORE INTO receipts(session, seq) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const seq of seqs) insert.run(me, seq);
    })();
  }

  pollNew(me: string, afterSeq: number): MessageRow[] {
    return this.db
      .query<MessageRow, [number, string]>(
        `SELECT * FROM messages WHERE seq > ?1 AND sender != ?2
           AND (kind = 'global' OR recipient = ?2) ORDER BY seq ASC`,
      )
      .all(afterSeq, me);
  }

  maxSeq(): number {
    const row = this.db.query<{ m: number | null }, []>("SELECT MAX(seq) AS m FROM messages").get();
    return row?.m ?? 0;
  }

  getPolicy(id: string): Policy {
    const row = this.db
      .query<{ notify_global: number; notify_direct: number; notify_urgent: number }, [string]>(
        "SELECT notify_global, notify_direct, notify_urgent FROM sessions WHERE id = ?",
      )
      .get(id);
    return {
      global: row ? row.notify_global === 1 : true,
      direct: row ? row.notify_direct === 1 : true,
      urgent: row ? row.notify_urgent === 1 : true,
    };
  }

  setPolicy(id: string, patch: Partial<Policy>): Policy {
    const next = { ...this.getPolicy(id), ...patch };
    this.db
      .query("UPDATE sessions SET notify_global = ?, notify_direct = ?, notify_urgent = ? WHERE id = ?")
      .run(next.global ? 1 : 0, next.direct ? 1 : 0, next.urgent ? 1 : 0, id);
    return next;
  }
}

export function defaultDbPath(): string {
  return process.env.MECCA_DB ?? join(homedir(), ".omp", "mecca", "mecca.db");
}

export function openStore(path: string = defaultDbPath()): Store {
  return new Store(path);
}
