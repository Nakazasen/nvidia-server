# Bridge Phase 1: Preflight Reader

## Bridge Phase 1 Scope

This is the first bridge integration between NVIDIA and ABW repos. Phase 1
implements a read-only/evidence-only preflight reader that validates ABW
evidence artifacts without modifying them or implementing bidirectional sync.

Gate: C. Bridge Preflight Reader + Contract Tests

## Read-Only / Evidence-Only Constraint

The preflight reader is strictly bounded:

- **Read-only**: Reads ABW evidence artifacts from `.brain/` directory.
- **Evidence-only**: Validates contract structure, not content semantics.
- **Fail-closed**: Returns FAIL on missing, invalid, or mismatched evidence.
- **No write-back**: Never modifies ABW artifacts or workspace state.
- **No sync**: No bidirectional data transfer or state synchronization.
- **No auto-promote**: Promotion decisions remain in ABW governed workflow.
- **No UI**: No user interface for bridge operations.

## Artifacts Read

The reader reads two ABW evidence artifacts:

| Artifact | Path | Schema Version |
|---|---|---|
| Ingest Report | `<abw-root>/.brain/ingest_report.json` | `abw.ingest_report.v1` |
| Ingest Gaps | `<abw-root>/.brain/ingest_gaps.json` | `abw.ingest_gaps.v1` |

## Schema Versions

| Artifact | Expected Schema |
|---|---|
| ingest_report.json | `abw.ingest_report.v1` |
| ingest_gaps.json | `abw.ingest_gaps.v1` |

Any other schema version produces a FAIL.

## Required Fields

### ingest_report.json

Top-level: `schema_version`, `run_id`, `created_at`, `workspace`, `command`,
`summary`, `items`, `safety`, `limitations`

Summary: `ingested_count`, `skipped_count`, `failed_count`, `quarantined_count`,
`draft_count`, `manifest_count`, `queue_count`

Items: `source_path`, `source_id`, `content_hash`, `status`, `draft_path`,
`manifest_status`, `queue_status`, `review_state`, `promotion_state`,
`domain_check`, `skip_reason`, `failure_reason`

Safety: `auto_promote_default`, `promotion_mode`, `domain_guard_active`

### ingest_gaps.json

Top-level: `schema_version`, `run_id`, `created_at`, `workspace`,
`gap_summary`, `gaps`, `limitations`

Gap summary: `total_gaps`, `blocking_gaps`, `warning_gaps`

Gap items: `source_path`, `source_id`, `gap_type`, `severity`,
`reason`, `evidence_ref`, `recommended_action`

## Correlation Validation

The two artifacts must share:
- Same `run_id`
- Same `created_at`
- Same `workspace`

Mismatch in any of these produces a FAIL.

## Status Rules

### FAIL conditions

- Missing `ingest_report.json`
- Missing `ingest_gaps.json`
- Invalid JSON (parse error)
- Unsupported schema_version
- Missing required top-level or nested fields
- `run_id` mismatch between report and gaps
- `created_at` mismatch between report and gaps
- `workspace` mismatch between report and gaps
- `auto_promote_default !== false`
- Any exception that prevents validation

### WARN conditions

- `domain_guard_active === false`
- `promotion_mode === "auto"`
- Any item `content_hash === "NOT_RECORDED"` or `"UNKNOWN"`
- Report has skipped/failed/quarantined items (count > 0)
- Gap summary has blocking_gaps > 0
- Gap summary has warning_gaps > 0
- Report or gaps `limitations` is not empty

### PASS conditions

- All required fields present and valid
- Schema versions match expected
- `run_id`, `created_at`, `workspace` correlate
- `auto_promote_default === false`
- No FAIL conditions
- No WARN conditions

## Fail-Closed Behavior

The reader follows fail-closed principle:
- Any evidence validation failure results in FAIL status.
- When FAIL, `ok` is `false`, and the caller should assume no valid bridge
  evidence is available.
- No optimistic or degraded PASS is permitted when validation fails.

## CLI Usage

```bash
# Run preflight against an ABW workspace
node tools/bridge-preflight.mjs --abw-root D:\Sandbox\skill-Anti-brain-wiki_note

# Run via npm script
npm run bridge:preflight -- --abw-root D:\Sandbox\skill-Anti-brain-wiki_note

# Run contract tests
npm run bridge:preflight:test
```

### Exit Codes

| Status | Exit Code |
|---|---|
| PASS | 0 |
| WARN | 0 |
| FAIL | 1 |

### Output Format

```json
{
  "status": "PASS|WARN|FAIL",
  "ok": true,
  "summary": {
    "report_schema": "abw.ingest_report.v1",
    "gaps_schema": "abw.ingest_gaps.v1",
    "run_id": "run-test-20260503T120000",
    "report_items": 1,
    "gap_items": 0
  },
  "errors": [],
  "warnings": [],
  "artifacts": {
    "ingest_report": "path/to/.brain/ingest_report.json",
    "ingest_gaps": "path/to/.brain/ingest_gaps.json"
  }
}
```

## Tests

Contract tests are in `tests/bridge-preflight.test.mjs`.

Run: `npm run bridge:preflight:test` or `node tests/bridge-preflight.test.mjs`

20 tests covering:
1. PASS happy path
2. Missing report -> FAIL
3. Missing gaps -> FAIL
4. Invalid JSON -> FAIL
5. Invalid gaps JSON -> FAIL
6. Unsupported report schema -> FAIL
7. Unsupported gaps schema -> FAIL
8. Missing required field -> FAIL
9. Missing required gap item field -> FAIL
10. run_id mismatch -> FAIL
11. created_at mismatch -> FAIL
12. auto_promote_default true -> FAIL
13. Blocking gaps -> WARN
14. Warning gaps -> WARN
15. domain_guard_active false -> WARN
16. promotion_mode auto -> WARN
17. content_hash NOT_RECORDED -> WARN
18. skipped/failed/quarantined count > 0 -> WARN
19. No writes to ABW evidence files
20. workspace mismatch -> FAIL

## Limitations

- Read-only; no write-back or sync capability.
- Evidence-only; does not validate semantic content correctness.
- Assumes ABW evidence artifacts follow the v1 schema contract.
- Does not implement bridge data transfer or state reconciliation.
- Status PASS/WARN/FAIL is local to the preflight check only.
- No UI or visual status panel.
- No autonomous or scheduled preflight runs.

## Non-Claims

- NOT a full NVIDIA<->ABW bridge.
- NOT bridge-ready for bidirectional operations.
- NOT production-ready.
- NOT Cognitive OS.
- NOT enterprise-grade security.
- NOT a sync mechanism.
- NOT an auto-promotion system.
- NO ABW mutation.
- NO NVIDIA project mutation beyond bounded tooling.
- NO UI implementation.
- NO write-back to ABW evidence files.
