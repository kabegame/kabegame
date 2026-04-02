# Cursor Plan mode — agent instructions

This document describes how **Plan mode** is used in this project: a **read-only, planning** phase before implementation. There is no per-session secret to substitute—behavior is fully described here.

## Purpose

First **research** and **clarify** without driving unrelated code changes. The planning deliverable for **this repo** is a **markdown plan file on disk under `.claude/plans/`**, with a **Todos** section at the tail.

## Workflow

1. **Research** — Search and read the codebase (and docs) as needed.
2. **Clarify** — If information is insufficient, the request is ambiguous, scope is too broad, or several valid implementations exist, use **AskQuestion** with **1–2 critical questions at a time** (not a long questionnaire).
3. **Write the plan file** — When research is done, create or update a file under **`.claude/plans/`** (create the directory if it does not exist). Use a **short, kebab-case** name, e.g. `cursor-plan-mode-doc.md`, `surf-context-menu.md`.
4. **Plan body** — Keep it concise, specific, and actionable. Use markdown; link repo paths as links (e.g. `[apps/main/foo.ts](../apps/main/foo.ts)` — adjust relative paths from `.claude/plans/` as needed).
5. **Todos at the end** — Finish the file with a **## Todos** (or **## TODO**) section listing concrete follow-ups as a task list, e.g. `- [ ] …` / `- [x] …` so progress can be checked off during implementation.
6. **Scope** — Match depth to the task; avoid over-engineering and unnecessary diagrams.

If Cursor Plan mode blocks file writes, draft the same structure in chat and ask the user to switch mode or paste into `.claude/plans/`—the intended shape is unchanged.

## Plan file layout (suggested)

```markdown
# <Title>

## Overview
One short paragraph.

## Scope
What is in / out.

## Plan
Numbered or bulleted steps, with file links.

## Todos
- [ ] First actionable item
- [ ] Second item
```

**No emojis** in plan files.

## Mermaid (when diagrams help)

Follow these rules so diagrams render reliably:

- **Node IDs**: no spaces; use `camelCase`, `PascalCase`, or `snake_case` (not `User Service`).
- **Edge labels** with parentheses or special characters: wrap in double quotes, e.g. `A -->|"O(1) lookup"| B`.
- **Node labels** with parentheses, commas, or colons: use quoted form, e.g. `A["Process (main)"]`, `B["Step 1: Init"]`.
- **Subgraphs**: use explicit IDs and labels: `subgraph auth [Authentication Flow]` (not `subgraph Authentication Flow`).
- **Reserved IDs**: do not use `end`, `subgraph`, `graph`, `flowchart` as node IDs; use e.g. `endNode[End]`.
- **No explicit colors/styling**: do not use `style`, `classDef`, or theme-breaking color directives (bad for dark mode).
- **Security**: `click` syntax is disabled—do not rely on it.

## Relation to Claude Code

Claude Code does not have a “Plan mode” toggle in the same way. Keeping plans under **`.claude/plans/`** aligns with Claude Code’s project config area and stays versionable with the repo.
