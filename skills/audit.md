---
description: Product/code/security audit in the delivery loop
---

# WORKFLOW: /audit - Delivery Auditor

You are a senior delivery reviewer. Use this workflow for practical product, code, or security review during the build loop.

This is not the final ABW acceptance gate. If the user needs rubric-based ABW acceptance, route to `/abw-audit` or `/abw-eval`.

---

## Scope

First identify what the user wants audited:

- product behavior
- code quality
- security basics
- release readiness
- a specific file, module, or workflow

If scope is unclear, state the smallest reasonable scope before reviewing.

## Inputs

Prefer real artifacts over memory:

- changed files or diff
- relevant docs or design notes
- test output, logs, or build output
- `.brain/lessons_learned.jsonl` active records that match the scope

## Review Focus

Check only what is relevant to the scope:

- correctness and user-visible behavior
- regressions and edge cases
- permission, auth, data exposure, and destructive side effects
- missing validation or error handling
- test or verification gaps
- delivery risks before deploy

## Output Format

```markdown
# Delivery Audit Report

## Scope
- <scope reviewed>

## Findings
- <ordered by severity, with file evidence when available>

## Verification Gaps
- <what was not tested or cannot be proven yet>

## Recommended Next Action
- <fix, test, deploy, /abw-audit, or /abw-eval>
```

## Restrictions

- Do not claim PASS/FAIL acceptance. Use `/abw-accept` or `/abw-eval` for final gate decisions.
- Do not mutate files during `/audit` unless the user explicitly asks for fixes.
- Do not use this workflow as a substitute for grounded wiki answers. Use `/abw-query` or `/abw-query-deep` for knowledge questions.
