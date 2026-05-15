# NVIDIA Phase 1 ABW CLI Reader

## Scope

This Phase 1 bridge step is read-only only.

It lets NVIDIA call ABW CLI JSON commands, parse the structured envelope, and
surface the result safely without creating pending edits, mutating disk, or
introducing sync/write-back behavior.

## Commands Covered

- `py -m abw.cli --json --workspace <workspace> version`
- `py -m abw.cli --json --workspace <workspace> doctor`
- `py -m abw.cli --json --workspace <workspace> ask "<question>"`

## NVIDIA Entry Points

- helper: `tools/abw-cli-reader.mjs`
- endpoints:
  - `POST /proxy/abw/version`
  - `POST /proxy/abw/doctor`
  - `POST /proxy/abw/ask`

## Envelope Preserved

The NVIDIA reader requires ABW JSON and preserves the ABW envelope:

- `schema_version`
- `command_name`
- `workspace`
- `generated_at`
- `status`
- `data`

For `ask`, NVIDIA preserves the bounded fields needed for machine-readable UI or
future bridge consumers:

- `answer`
- `retrieval_status`
- `trust_score`
- `sources`
- `warnings`
- `gap_logged`
- `gap_id`
- `current_state`
- `knowledge_evidence_tier`
- `knowledge_source_score`
- `source_summary`
- `logs`
- `provider`

## NVIDIA Bridge Statuses

- `ABW_CLI_OK`
- `ABW_CLI_NOT_FOUND`
- `ABW_CLI_TIMEOUT`
- `ABW_CLI_NONZERO_EXIT`
- `ABW_CLI_INVALID_JSON`
- `ABW_CLI_SCHEMA_UNSUPPORTED`
- `ABW_CLI_WORKSPACE_REQUIRED`
- `ABW_CLI_TRUST_REQUIRED`
- `ABW_CLI_WRONG_WORKSPACE`
- `ABW_CLI_NO_MATCH`
- `ABW_CLI_GAP_LOGGED`
- `ABW_CLI_AMBIGUOUS`
- `ABW_CLI_NO_CONFIDENT_WORKSPACE`
- `ABW_CLI_BLOCKED`

## Safety Boundaries

- child-process only; does not call NVIDIA `execute_command`
- explicit workspace is required
- current NVIDIA workspace must match the requested ABW workspace
- active workspace must be trusted
- no `apply`
- no pending edits
- no file mutation
- no sync
- no auto-promote
- no Review + Apply bypass

## Tests Run

- `node tests/abw-cli-reader-bridge.test.mjs`
- `npm test`

## What This Proves

- NVIDIA can invoke bounded ABW CLI JSON commands safely
- NVIDIA rejects invalid JSON and unsupported envelopes instead of parsing prose
- NVIDIA classifies no-match/gap states deterministically
- trusted-workspace enforcement still applies to the read-only bridge path
- the bridge path does not create pending edits or mutate workspace files

## What This Does Not Prove

- not full bridge
- not write-back
- not sync
- not auto-apply
- not ABW mutation
- not `DAILY_USE_READY`
- not production-ready
- not broad provider matrix readiness
- not ABW retrieval quality beyond the underlying ingest/retrieval state
