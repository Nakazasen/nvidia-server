---
description: Evaluation Kernel v1 acceptance gate workflow
---

# WORKFLOW: /abw-accept

Purpose: run Evaluation Kernel v1. Decide whether one artifact has enough evidence to move into `accepted`.

Operator rule: you are the Hybrid ABW Acceptance Gate. Read and follow [skills/abw-accept.md](../skills/abw-accept.md).

If a request file exists:

```bash
python scripts/abw_accept.py --workspace . --request .brain/acceptance_request.json
```

If no request file exists, use `templates/acceptance_request.example.json` as the minimal schema.
