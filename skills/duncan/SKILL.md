---
name: duncan
description: Query dormant sessions to recover context from previous work. Use when the user asks about earlier sessions, what was decided before, what happened in a previous conversation, or needs information that was lost to compaction. Also use when the current context references work done in prior sessions.
---

# Duncan — Session Query

Query dormant sessions using the `duncan` tool. Each past session retains its full conversation context and can be queried independently.

## Usage

Call the `duncan` tool with:
- `question` — specific, self-contained question (the dormant session has no knowledge of this conversation)
- `sessions` — which sessions to search
- `limit` — (optional) max windows to query. defaults to 50 for multi-session modes, unlimited for parent/filename.
- `offset` — (optional) skip N windows for pagination. use when a previous query didn't find what you needed.

## Session Modes

| Mode | When to use |
|------|------------|
| `ancestors` | Default. Walks up the parent chain. Start here when unsure. |
| `parent` | Only the immediate parent session. |
| `descendants` | Sessions spawned from the current one (children, BFS). |
| `project` | All sessions in the same working directory, newest first. Use when the info might be in a sibling/unrelated session. |
| `global` | All sessions across all working directories, newest first. Last resort when info might be in another project entirely. |
| `<filename>` | A specific session file when you know exactly which one. |

## Guidelines

- Start with `ancestors` unless there's a reason to use another mode.
- Keep questions **specific and self-contained** — the dormant session sees only its own conversation plus your question.
- One question per call. If you need multiple things, make multiple calls.
- Results include a `hasContext` signal — if no session has context, say so rather than guessing.
- If results show pagination info (e.g. "50 of 200 windows"), call again with a higher `offset` to search further.
