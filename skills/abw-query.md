---
description: ABW wiki-first query path
---

## BINDING STRATEGY

- `/abw-query` is explicit ABW invocation and must run through the CLI runner.
- Any answer is only a DRAFT until `py scripts/abw_runner.py --json-input` validates or executes it.
- Invoke `py scripts/abw_runner.py --json-input` and validate the tentative answer through that runner call.
- Do not emit a raw knowledge answer.
- Raw model answers are invalid.
- If execution mode is not used, validation mode is mandatory.
- After the runner returns, you MUST pass the payload through `py scripts/abw_output.py`.
- Return the runner output itself rather than rewriting it.
- Final knowledge output must expose `binding_status`, `knowledge_evidence_tier`, and `knowledge_source_score`.

## VISIBILITY LOCK

Before returning:
- You MUST expose `binding_status`.
- You MUST expose `validation_proof`.
- If either is missing or invalid, you MUST mark the output as `UNVERIFIED`.
- If the outer binding shim rejects the payload, return only the rejected runner shape.

# WORKFLOW: /abw-query

**Mục đích:** Trả lời nhanh bằng cách recap `.brain/`, tìm trong `wiki/`, rồi mới fallback sang MCP hoặc gap log nếu cần.

**Hướng dẫn cho AI:**
Bạn là chuyên gia Anti-Brain-Wiki. Hãy đọc và thực hiện quy trình trong: [skills/query-wiki.md](../skills/query-wiki.md).
