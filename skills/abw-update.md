---
description: Perform a full Hybrid ABW runtime update with MCP patching and post-install verification
---

# WORKFLOW: /abw-update

Purpose: update the installed Hybrid ABW runtime and prove that the runtime is actually ready.

This is an operational deployment command. It must not report success just because files were copied.

## What `/abw-update` Must Distinguish

Always report these separately:

- `repo_state`
- `workspace_state`
- `runtime_state`
- `mcp_sync_result`

Do not collapse them into one vague "updated" message.

Examples of legitimate states:

- repo updated, workspace stale, runtime stale
- repo reachable, workspace synced, runtime updated, MCP stale
- runtime updated, MCP updated, workspace still behind remote
- all synced

## Required Runtime Artifacts

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

If any required artifact is missing in the source catalog or missing after install, classify the update as `FAIL`.

## Required MCP Runtime Registration

The installer must patch:

- Windows: `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
- POSIX: `$HOME/.gemini/antigravity/mcp_config.json`

Expected shape:

```json
{
  "mcpServers": {
    "abw_runner": {
      "command": "ABSOLUTE_PYTHON_OR_LAUNCHER",
      "args": ["ABSOLUTE_PATH_TO_RUNTIME/scripts/abw_runner.py"]
    }
  }
}
```

Rules:

- preserve unrelated MCP servers
- create `mcpServers` if missing
- use absolute paths
- validate JSON after patch
- validate that the configured `abw_runner.py` path exists
- if MCP patching or validation fails, classify the update as `FAIL`

## Execution

When the user explicitly asks to update now, run the installer for the current host.

Preferred commands:

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS/Linux:

```bash
bash ./install.sh
```

If no usable local clone exists, provide the remote installer command instead of pretending the local workspace was updated.

Windows:

```powershell
irm https://raw.githubusercontent.com/Nakazasen/skill-Anti-brain-wiki_note/main/install.ps1 | iex
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Nakazasen/skill-Anti-brain-wiki_note/main/install.sh | sh
```

## Required Verification

Do not stop at installer stdout. Verify the installed runtime.

Minimum verification:

- required scripts exist in the runtime scripts directory
- required workflows exist in the runtime workflow directory
- MCP config parses as valid JSON
- MCP config contains a valid `abw_runner` entry only when `ABW_INSTALL_MCP=1`
- MCP config points to the installed runtime `abw_runner.py` only when MCP registration is explicitly enabled
- `finalization_check.py` exists
- `abw-update.md` exists
- `GEMINI.md` still contains the Hybrid ABW registration block if the installer manages it

Additional verification where available:

- `py_compile` for critical runtime scripts
- command-surface docs validation if the workflow/help surface changed

If a verification step cannot run on the current host, report that limitation explicitly. Do not silently skip it.

## Final Output Contract

The update report must include:

1. `source_sync_result`
2. `runtime_sync_result`
3. `mcp_sync_result`
4. `verification_result`
5. `final_verdict`

Allowed verdicts:

- `PASS`
- `PARTIAL`
- `FAIL`

Verdict rules:

- missing required artifact -> `FAIL`
- MCP patch missing or invalid -> `FAIL`
- verification skipped without explicit limitation -> `FAIL`
- runtime updated but workspace stale -> `PARTIAL`
- runtime and MCP verified, workspace acceptable -> `PASS`

## Reporting Guidance

The final user-facing report should say:

- whether the installer actually ran
- whether the source was `LOCAL` or `REMOTE`
- whether required runtime scripts exist
- whether required runtime workflows exist
- whether MCP registration for `abw_runner` is valid
- whether the workspace itself is stale relative to remote
- whether a reload may still be needed for slash-command discovery

## Rules

- Do not call this an AWF update.
- Do not claim success if the installer did not actually run.
- Do not claim success if MCP patching failed.
- Do not claim success if required runtime artifacts are missing.
- Do not hide a stale workspace clone behind a successful runtime install.
- Do not say "all synced" unless repo, workspace, runtime, and MCP are all explicitly verified.
