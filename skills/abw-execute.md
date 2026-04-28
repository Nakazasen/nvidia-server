---
description: Execute one gated continuation step after /abw-resume approval
---

# WORKFLOW: /abw-execute - Governed Continuation Executor

You are the **Hybrid ABW Continuation Executor**. Your job is to execute exactly one continuation step after it has passed the Continuation Kernel gate.

This workflow is intentionally conservative. It does not replace `/code`, `/debug`, or `/test`; it wraps them with execution governance.

---

## Non-Negotiable Rule

Do not execute if the step has not passed the machine gate.

Preferred prepare command:

```bash
python scripts/continuation_execute.py prepare --workspace .
```

If the selected step requires approvals, the user must explicitly approve before prepare can proceed:

```bash
python scripts/continuation_execute.py prepare --workspace . --step-id <step_id> --approved --approval-note "<user approval summary>"
```

---

## Trigger

Use this workflow when the user says:

- `/abw-execute`
- "execute the selected resume step"
- "run the next safe step"
- "do the step from /abw-resume"

Do not use this for broad feature work. If the work is not already represented as a continuation backlog step, go back to `/abw-resume` and propose/approve a step first.

---

## Phase 1: Prepare

1. Run the prepare command.
2. Parse the JSON result.
3. If `status = blocked`, stop and report the block reason.
4. If `status = approval_required`, stop and ask the user for explicit approval.
5. If `status = prepared`, continue.

The prepare phase writes:

- `.brain/active_execution.json`
- `resume_state.active_step`
- backlog step status `active`
- handover event `step_started`

---

## Phase 2: Execute Within Bounds

Execute only the prepared step.

Rules:

- Touch only `candidate_files` unless the user explicitly approves a changed scope.
- Do not refactor outside the selected step.
- Do not reverse locked decisions.
- Do not enter `user_declared + high` unsafe zones.
- If unexpected scope expansion is needed, stop and return to `/abw-resume`.
- If tests/checks are relevant, run the smallest relevant check.

Use existing implementation workflows as needed:

- `/code` for bounded edits
- `/debug` for a narrow bug
- `/test` for validation
- `/abw-audit` for historical unsafe zones

If multiple models are working in the same repo, claim the step before editing:

```bash
python scripts/continuation_claim.py claim --workspace . --model-id <model-id> --step-id <step_id>
```

If a rollback may be needed, inspect the plan before editing:

```bash
python scripts/continuation_rollback.py plan --workspace .
```

---

## Phase 3: Record Outcome

After execution, record the result:

```bash
python scripts/continuation_execute.py record \
  --workspace . \
  --step-id <step_id> \
  --outcome success \
  --changed-file <path> \
  --test-result pass \
  --errors-introduced 0 \
  --acceptance-result pass \
  --handover-note "What changed and what the next agent should know"
```

Valid outcomes:

- `success`
- `partial`
- `failed`

Valid test results:

- `pass`
- `fail`
- `skipped`
- `null`

The record phase appends `.brain/step_history.jsonl`, appends `.brain/handover_log.jsonl`, updates `resume_state`, updates backlog status, and clears `.brain/active_execution.json`.

The record phase also creates a lightweight completion artifact:

- `acceptance_result`: `pass`, `fail`, `partial`, or `not_checked`
- `handover_note`: short note for the next agent
- `lessons_learned`: optional reusable lessons
- `post_execute_audit`: deterministic scope/validation audit

The post-execute audit is not a deep `/abw-audit`. It checks for:

- changed files outside `candidate_files`
- failed tests or introduced errors
- partial/failed outcomes
- missing passing validation

If `post_execute_audit.requires_abw_audit = true`, stop and run `/abw-audit` before treating the step as accepted.

A step is marked `completed` only when all of these are true:

- `outcome = success`
- `acceptance_result = pass`
- `post_execute_audit.status = pass`

Otherwise the attempt is recorded honestly as `partial` or `failed`; it is not added to `completed_steps`.

---

## Output

Report:

- executed step id,
- files changed,
- checks run,
- outcome,
- any deviations from candidate files,
- post-execute audit status,
- acceptance result,
- accepted true/false,
- whether state was recorded successfully.

If the step failed, recommend `/abw-learn` only when there is a reusable behavioral lesson.

---

## Restrictions

- Do not execute without prepare.
- Do not execute blocked steps.
- Do not treat missing approval as implicit approval.
- Do not hide partial or failed outcomes.
- Do not overwrite handover or step history; append only.
