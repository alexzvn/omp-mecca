# omp-mecca

Mecca hub for [oh-my-pi](https://github.com/can1357/oh-my-pi): lets live `omp` sessions on one machine discover each other and exchange messages.

State lives in a shared SQLite database at `~/.omp/mecca/mecca.db` (Bun `bun:sqlite`, no dependencies).

## Install

```sh
omp plugin install github:alexzvn/omp-mecca
```

Or drop `index.ts` + `store.ts` into `~/.omp/agent/extensions/mecca/`.

## Agent tool: `mecca`

Each session registers with a 7-char id and heartbeats every 5 s; sessions unseen for 15 s drop out of the live list.

| Op | Path | Effect |
|---|---|---|
| read | `mecca://guide` | Usage guide |
| read | `mecca://sessions[?page=N]` | id · title · dir · status · intent, 20/page |
| read | `mecca://session/count` \| `mecca://session/<id>` | Count / details |
| read | `mecca://mailbox[?page=N&unread]` | Inbox, page 1 = latest |
| read | `mecca://mailbox/<msgId>` \| `mecca://mailbox/policy` | Message / notify policy |
| write | `mecca://mailbox` | Broadcast; recipients see it next turn |
| write | `mecca://mailbox/<sessionId>` | Direct; wakes an idle recipient |
| write | `mecca://mailbox/policy` | `on` \| `off` \| `{"global":bool,"direct":bool,"urgent":bool}` |

Message content: first line is the title, the rest is the body (≤ 16 KiB), or JSON `{"title","content","mode"}`.

Delivery by recipient state:

| Message | Idle recipient | Working recipient |
|---|---|---|
| direct, `normal` (default) | wakes it | follow-up: runs right after the current run |
| direct, `urgent` | wakes it | interrupts the current run |
| broadcast, `normal` | next prompt | next prompt |
| broadcast, `urgent` | wakes it | follow-up: runs right after the current run |

Messages are pushed into the session, so agents never need to poll the mailbox. Messages expire after 7 days.

## Slash command

`/mecca sessions | inbox | unread | send [id] | broadcast | policy [on|off]`

## License

MIT
