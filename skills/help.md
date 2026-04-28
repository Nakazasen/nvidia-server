---
description: Quick command guide for the Hybrid ABW workflow surface
---

# WORKFLOW: /help

This document is the quick reference for the Hybrid ABW command surface.

## Start Here

- New workspace with no ABW structure: `/abw-init`
- Unsure which lane to use: `/abw-ask`
- Continuing interrupted work: `/abw-resume`
- Evaluating results before acceptance: `/abw-eval`
- Updating installed runtime: `/abw-update`
- Read-only runtime audit: `/abw-health`
- Runtime repair: `/abw-repair`

## Key Operational Commands

- `/abw-ask`: route a question or task to the correct ABW lane
- `/abw-query`: fast wiki lookup
- `/abw-query-deep`: bounded deeper reasoning over project knowledge
- `/abw-bootstrap`: greenfield reasoning without fake knowledge
- `/abw-resume`: governed continuation entry point
- `/abw-execute`: execute the selected continuation step
- `/abw-eval`: audit, meta-audit, and acceptance chain
- `/finalization`: apply and check finalization state
- `/abw-update`: install and verify the runtime
- `/abw-health`: inspect runtime drift, encoding issues, and health metrics without modifying files
- `/abw-repair`: repair runtime drift and encoding issues

## `/abw-update` Guidance

Use `/abw-update` when you need to refresh the installed ABW runtime in `~/.gemini/antigravity`.

`/abw-update` must report these states separately:

- `repo_state`
- `workspace_state`
- `runtime_state`
- `mcp_sync_result`

`/abw-update` must verify these artifacts:

- scripts: `abw_runner.py`, `finalization_check.py`, `abw_accept.py`, `continuation_gate.py`, `continuation_execute.py`
- workflows: `abw-ask.md`, `abw-update.md`, `finalization.md`
- MCP config: optional `abw_runner` entry only when `ABW_INSTALL_MCP=1`

Final update verdicts:

- `PASS`: runtime and MCP are verified, with no critical gaps
- `PARTIAL`: runtime is updated, but the workspace itself is stale or otherwise not fully aligned
- `FAIL`: required artifacts are missing, MCP patching failed, or verification is incomplete/invalid

## Minimal Flow Examples

New project:

```text
/abw-init -> /abw-setup -> /brainstorm -> /plan -> /design -> /code -> /test -> /abw-eval
```

Interrupted project:

```text
/abw-resume -> /abw-execute -> /abw-eval
```

Runtime refresh:

```text
/abw-update
```

## Rule

Do not treat installer output alone as proof that the runtime is ready. For `/abw-update`, runtime verification is part of the command, not an optional extra.
