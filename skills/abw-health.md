---
description: Read-only ABW runtime health audit
---

# WORKFLOW: /abw-health

## Rule

- `/abw-health` is read only.
- You MUST execute `py scripts/abw_health.py --mode audit`.
- You MUST NOT call `fix_drift`.
- You MUST NOT call `fix_encoding`.
- Return the script output as-is.
