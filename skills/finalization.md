# Finalization Profile

Use this profile for any terminal answer, report, audit, acceptance verdict, or session wrap-up.

## Allowed Final States

- `code_changed_only`
- `runs_one_case`
- `checked_only`
- `verified`
- `blocked`

## State Rules

- `code_changed_only`: files or docs changed, but there is no runtime proof yet.
- `runs_one_case`: one example, one test, or one weak signal only. This is not verification.
- `checked_only`: some evidence exists, but it is incomplete or not independently checkable enough for a stronger label.
- `verified`: the claim or change has direct checkable evidence.
  - For code or runtime work: terminal output, test output, logs, or another reproducible execution trace.
  - For knowledge answers: explicit provenance and source traceability.
  - For eval / acceptance: audit, meta-audit, and rubric conditions are satisfied.
- `blocked`: required evidence is missing, conflicting, unavailable, or insufficient to close the task.

## Overclaim Ban

- Do not say `done`, `complete`, `fixed`, or `PASS` unless the required evidence for the task type is present.
- Do not treat explanation, intent, or static reasoning as proof.
- Do not promote a partial signal to full completion.

## Required Tail Block

Every terminal output must end with:

```markdown
## Finalization
- current_state: <code_changed_only|runs_one_case|checked_only|verified|blocked>
- evidence: <what directly supports the state>
- gaps_or_limitations: <what is still missing or uncertain>
- next_steps: <the smallest safe next action>
```

## Minimal Selection Rule

- If you changed code but did not verify it, use `code_changed_only`.
- If you only ran one case, use `runs_one_case`.
- If evidence is real but incomplete, use `checked_only`.
- If the task is closed by checkable proof, use `verified`.
- If proof is missing or the task cannot be closed, use `blocked`.

## Checker

Run `scripts/finalization_check.py` on the drafted finalization block before emitting the final answer.

- `pass` means the state is acceptable as written.
- `downgrade` means the label is too strong and must be lowered.
- `blocked` means the block is malformed, contradictory, or missing required support.
