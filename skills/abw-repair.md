---
description: Mutating ABW runtime repair
---

# WORKFLOW: /abw-repair

## Rule

- `/abw-repair` is mutating.
- You MUST execute `py scripts/abw_health.py --mode repair`.
- This command is allowed to run `fix_drift`.
- This command is allowed to run `fix_encoding`.
- Return the script output as-is.
