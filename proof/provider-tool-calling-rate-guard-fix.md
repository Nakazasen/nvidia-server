# NVIDIA Real UI Provider Tool-Calling Selection + Rate Guard Surfacing

Date: 2026-05-13

## Before state

- Active blocker: real UI provider/model selection could route `/proxy/chat` into unsupported tool-calling combinations.
- Known failure risks before fix:
  - unsupported provider/model could still be sent `tools`
  - unsupported provider/model could still be sent `tool_choice`
  - real UI could collapse unsupported tool-calling into a generic provider failure
  - rate guard surfacing had to remain explicit as `PROVIDER_RATE_GUARD_BLOCKED`

## Files changed

- `tools/nvidia-server.mjs`
- `nvidia_playground.html`
- `tests/provider-tool-calling-capability.test.mjs`

## What changed

- Added an explicit provider capability layer for deterministic `/proxy/chat` tool-calling.
- `/proxy/chat` now resolves the selected configured provider without silently falling back to NVIDIA.
- Unsupported runtime combinations return structured classification:
  - `PROVIDER_TOOL_CALLING_UNSUPPORTED`
- Classified result explicitly states:
  - selected provider
  - selected model
  - unsupported fields
  - `providerCallAttempted: false`
  - `mutationApplied: false`
  - `diskMutated: false`
- SSE/stream path now returns the same classification instead of degrading into a generic failure.
- Real UI status summary now surfaces:
  - provider capability block
  - provider rate guard block
- Fixture-backed deterministic tests remain allowed to use the synthetic tool-calling harness so existing local proofs stay stable.

## Tests run

- `node tests/provider-tool-calling-capability.test.mjs`
  - PASS 16/0
- `npm test`
  - FAIL
  - Missing script: `test`
- `npm run manual:reliability`
  - PASS 122/0
- `npm run apply:proof`
  - PASS 30/0
- `npm run move:proof`
  - PASS 71/0
- `npm run agent:audit`
  - PASS 25/25
- `npm run soak:proof`
  - PASS 141/0
- `npm run browser:smoke`
  - PASS 118/0
  - warning only: inline edit widget not observable in current smoke state

## Behavior proven

- Unsupported configured provider path returns `PROVIDER_TOOL_CALLING_UNSUPPORTED`.
- Unsupported configured provider path preserves selected provider id in the classified result.
- Unsupported configured provider path blocks `tools` before provider call.
- Unsupported configured provider path blocks `tool_choice` before provider call.
- Unsupported configured provider stream path classifies `stream_with_tools` as unsupported.
- Unsupported configured provider path reports `providerCallAttempted: false`.
- Unsupported configured provider path reports `mutationApplied: false`.
- Unsupported configured provider path reports `diskMutated: false`.
- Unsupported configured provider path creates no pending edit.
- Unsupported configured provider path creates no disk file.
- Existing manual deterministic workflow proof still passes.
- Existing rate guard classification still passes as `PROVIDER_RATE_GUARD_BLOCKED`.
- Existing workspace mismatch blocking still passes.
- Existing target path mismatch blocking still passes.
- Existing move/rename contract still passes.
- Existing review/apply contract still passes.
- Browser smoke still passes.
- Agent capability audit still passes.

## Remaining blockers

- `npm test` is still unavailable because `package.json` has no `test` script.
- Real provider/model matrix beyond the explicitly supported deterministic NVIDIA tool-calling path is still not implemented.
- Manual/path revalidation v3 itself was not rerun in this change set.

## Retry recommendation

- `MANUAL_PATH_REVALIDATION_V3` can be retried.
- Primary focus for retry:
  - unsupported provider selected in UI
  - unsupported provider stream path
  - rate guard block path in real UI
