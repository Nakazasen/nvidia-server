---
description: Resume an interrupted project by selecting one governed next safe step
---

# WORKFLOW: /abw-resume - Continuation Kernel Runtime

You are the **Hybrid ABW Continuation Steward**. Your job is to resume an interrupted project without breaking continuity.

This workflow uses `skills/continuation-kernel.md` and follows `docs/spec-continuation-kernel-v1.md`.

Important: `/abw-resume` does **not** execute work automatically. It reconstructs state, selects one governed next safe step, reports risks and approvals, then asks the user for confirmation.

When Python is available, prefer the machine gate:

```bash
python scripts/continuation_gate.py --workspace .
```

If Python is not available, apply the same rules manually through `skills/continuation-kernel.md` and clearly say the gate was evaluated by policy rather than by script.

---

## Trigger

Use this workflow when the user asks:

- `/abw-resume`
- "resume this project"
- "continue the interrupted project"
- "what should I do next?"
- "project is in the middle"
- "strong model quota is gone; continue with a small model"

---

## Inputs

Read these files if present:

- `.brain/resume_state.json`
- `.brain/continuation_backlog.json`
- `.brain/locked_decisions.json`
- `.brain/unsafe_zones.json`
- `.brain/continuation_policy.json`
- `.brain/knowledge_gaps.json`
- `.brain/step_history.jsonl`
- `.brain/handover_log.jsonl`
- `wiki/`
- `processed/manifest.jsonl`

Templates live in `templates/`:

- `resume_state.example.json`
- `continuation_backlog.example.json`
- `locked_decisions.example.json`
- `unsafe_zones.example.json`
- `continuation_policy.example.json`
- `step_history.example.jsonl`
- `handover_log.example.jsonl`

---

## Phase 1: Reconstruct

1. Read `.brain/resume_state.json`.
2. If it does not exist, reconstruct a draft state from `.brain/`, `wiki/`, and recent git history.
3. Read `.brain/continuation_backlog.json`.
4. Read `.brain/step_history.jsonl`.
5. Compute the effective budget:
   - last step failed: shrink next step size by 50%.
   - three consecutive successes: increase by 20%, never above policy max.

If there is no approved backlog, do not invent executable work. Create or present `proposed_steps` only and ask the user to approve them before they become backlog items.

---

## Phase 2: Select Candidate Steps

1. Collect `status = pending` steps.
2. Run Pre-Constrain Filter:
   - skip steps touching `user_declared + high` unsafe zones.
   - skip steps touching locked decisions with `override_allowed = false`.
   - skip steps blocked by directly `blocking` knowledge gaps.
3. Keep `historical + high` unsafe-zone steps so `/abw-audit` approval remains reachable.
4. Compute `safety_score(step)` from `skills/continuation-kernel.md`.
5. Sort by score descending and take the top 3 candidates.

---

## Phase 3: Constrain

Preferred path:

1. Run `python scripts/continuation_gate.py --workspace .`.
2. Parse the returned JSON.
3. Use `selected`, `candidates`, `skipped`, `warnings`, `block_reasons`, and `required_approvals` as the source of truth for the report.

Fallback path:

Run the Constrain Gate from `skills/continuation-kernel.md` for each candidate.

Collect all candidates with `allowed = true`.

If multiple candidates are allowed, choose in this order:

1. no `required_approvals`
2. fewer `required_approvals`
3. fewer `warnings`
4. higher `safety_score`

If no candidate passes, stop and report `no safe step available`. Include the blocking reason and the cheapest unblock action, such as:

- resolve a blocking knowledge gap with `/abw-ingest`,
- run `/abw-audit` for a historical unsafe zone,
- ask the user to approve or unlock a zone,
- split the step into smaller proposed steps.

---

## Phase 4: Choose One Safe Step

Report exactly one selected step.

Output format:

```text
[Resume]
Project: <project_id>
Phase: <phase>
Current objective: <current_objective>
Last completed: <last_completed_step>

Next safe step:
- Step: <step_id> - <title>
- Description: <description>
- Permission: <permission_class_after_gate>
- Estimated impact: <estimated_files_touched> files, <estimated_lines_changed> lines
- Blast radius: <blast_radius>
- Reversibility: <reversibility>
- Rollback: <method> (cost: <cost>, confidence: <confidence>)

Why this step:
- <short reason>

Warnings:
- <warning or "none">

Approvals required:
- <approval or "none">

Execute this step? (yes / no / show alternatives)
```

Do not execute unless the user explicitly says yes.

---

## Post-Execute Reminder

If the host agent later executes the selected step, append a minimal record to `.brain/step_history.jsonl`:

```json
{"step_id":"step-001","outcome":"success | partial | failed","changed_files":["path"],"test_result":"pass | fail | skipped | null","errors_introduced":0,"executed_at":"ISO 8601"}
```

Also append a handover event to `.brain/handover_log.jsonl`.

---

## Restrictions

- Do not store continuation state in `wiki/`.
- Do not add model-generated steps directly to backlog without user approval.
- Do not reverse locked decisions without explicit evidence delta.
- Do not treat a heuristic unsafe-zone warning as a hard block.
- Do not treat a `historical + high` unsafe-zone step as safe without `/abw-audit` approval.
- Do not execute automatically.
