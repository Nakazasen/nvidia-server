# Sprint 18: Browser Smoke Modularization

## What was extracted
The monolith `tools/browser-smoke.mjs` was split into smaller modules under `tools/smoke/`:
- `tools/smoke/core.mjs`: Extracted low-level HTTP and timing utilities (`fetchText`, `requestJson`, `sleep`, `waitForServer`).
- `tools/smoke/api-regression.mjs`: Extracted the `runApiRegressionChecks` logic, executing all the `/api/` endpoint regression validations.
- `tools/smoke/guard-matrix.mjs`: Extracted the `runGuardMatrixChecks` logic, iterating through the `guardActions` and performing the real endpoint mutation guard regression checks.

## What remains in entrypoint
`tools/browser-smoke.mjs` remains the main entrypoint and orchestrates the tests. It retains:
- CLI argument parsing (`parseArgs`)
- Local server lifecycle (`startLocalServer`, `stopLocalServer`, `isProcessRunning`)
- File artifact and report generation (`saveArtifact`, `ensureReportsDir`, `addCheck`)
- Global `SUMMARY` and `LOG_LINES` state
- Playwright core logic (`runRealBrowserSmoke`, browser launch, DOM readiness, selectors, `page.evaluate` DOM checks)
- Main execution loop (`main`), HTTP fallback (`runHttpFallback`), and the Sprint 16 daily-use readiness report generation.

## Validation Commands
```bash
node --check tools/browser-smoke.mjs
node --check tools/smoke/core.mjs
node --check tools/smoke/api-regression.mjs
node --check tools/smoke/guard-matrix.mjs
npm run budget:check
npm run runtime:hygiene
npm run agent:audit
npm run browser:smoke -- --start-server --port 3456
```

## Check Count Verification
- Baseline Sprint 17 remained `99 passed / 0 failed`.
- Sprint 18 modularization run also remained `99 passed / 0 failed`.
- No duplicate `/api/health` check was introduced.
- No duplicate guard matrix summary check was introduced.
- Count behavior is unchanged; any `100/0` report is not accepted as final evidence.

## Limitations & Non-Claims
- Browser smoke is **baseline evidence**, not a full E2E proof.
- Not production-ready.
- Not Cognitive OS achieved.
- Not VS Code parity.
- Not Cursor parity.
- Not enterprise-grade security.
- Full ABW bridge not implemented.
- Self-growing wiki not implemented.
- Autonomous self-learning not implemented.
- Mature self-ingesting knowledge system not achieved.

## Carry-Over Risks
- The Playwright DOM evaluation logic inside `page.evaluate` remains a monolith inside `tools/browser-smoke.mjs`. It is highly sensitive to DOM changes and may require a different strategy (like injecting a script tag) to safely modularize further.
- Server lifecycle and `SUMMARY` global state were kept in the entrypoint to avoid breaking reporting and orphan cleanup behaviors, but they could be moved to a robust test-runner state object in the future.
- Security rotation and idle memory bounds were not strictly asserted as failing checks if absent, matching the existing behavior.
