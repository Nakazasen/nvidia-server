# Hybrid ABW Workflow Surface

This directory defines the public workflow command surface for Hybrid ABW.

## Core Entry Points

- `/abw-ask`: primary router for Hybrid ABW requests
- `/abw-eval`: evaluation and acceptance chain
- `/abw-start`: session start and runtime status check
- `/abw-update`: runtime deployment and sync verification
- `/abw-health`: read-only runtime health audit
- `/abw-repair`: runtime health repair path

## `/abw-update` Runtime Contract

`/abw-update` is not just a file copy command. It is the deployment path that must prove runtime readiness.

The update flow must distinguish:

- `repo_state`
- `workspace_state`
- `runtime_state`
- `mcp_sync_result`

The update flow must verify:

- required runtime scripts exist after install
- required runtime workflows exist after install
- MCP config contains a valid `abw_runner` registration only when `ABW_INSTALL_MCP=1`
- the configured runner path exists
- `GEMINI.md` registration was refreshed if managed by the installer

Required scripts:

- `abw_runner.py`
- `finalization_check.py`
- `abw_accept.py`
- `continuation_gate.py`
- `continuation_execute.py`

Required workflows:

- `abw-ask.md`
- `abw-update.md`
- `finalization.md`

Expected update result fields:

- `source_sync_result`
- `runtime_sync_result`
- `mcp_sync_result`
- `verification_result`
- `final_verdict`

Allowed verdicts:

- `PASS`
- `PARTIAL`
- `FAIL`

## Command Naming

- `abw-*` commands are the ABW-first workflow surface.
- Non-`abw-*` commands such as `/plan`, `/code`, and `/test` remain compatibility and delivery workflows.
- If a public workflow name changes, installer/runtime registration and docs must be updated together.

## Operational Rule

Do not claim the runtime is updated unless the installed runtime and verification checks pass. MCP registration is optional and must pass only when explicitly enabled.
