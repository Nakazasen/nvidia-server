# Sprint 16.5 Cleanup Plan: Modularization Prep

## Objective
To outline the module split plan and lightweight boundary markers for the upcoming Sprint 17, focusing on transitioning `nvidia-server.mjs`, `browser-smoke.mjs`, `agent-core.mjs`, and `nvidia_playground.html` towards a more modular architecture without performing a full rewrite in the current sprint.

## Current State Analysis
Based on the performance budget metrics:
- `nvidia_playground.html`: ~286KB, ~5.7K lines
- `tools/nvidia-server.mjs`: ~180KB, ~3.5K lines
- `tools/agent-core.mjs`: ~53KB, ~942 lines
- `tools/browser-smoke.mjs`: ~57KB, ~1.1K lines

These files have grown significantly, making maintenance and feature addition complex. The goal is to establish clear boundaries for future extraction.

### Measurement Note (Line Count Consistency)
- Historical gate review used a PowerShell line metric (`Get-Content | Measure-Object -Line`) that reported `nvidia_playground.html` around 5,704 lines.
- Sprint 16.5 budget output uses a cross-platform newline split (`/\r\n|\n|\r/`) and currently reports 6,324 lines.
- This discrepancy is a measurement-method difference, not evidence of an unsafe runtime cleanup action.

## Modularization Strategy

### 1. `nvidia-server.mjs` Split Plan
**Current Role**: Handles routing, API endpoints, static file serving, workspace integration, extensions host logic, and runtime hygiene.
**Proposed Split**:
- **`server-core.mjs`**: Basic HTTP server setup, middleware, and static file serving.
- **`routes/api-agent.mjs`**: API endpoints related to agent interaction (e.g., `/api/chat`, `/api/inline_edit`).
- **`routes/api-workspace.mjs`**: API endpoints for workspace context, file indexing, and tools.
- **`services/extensions.mjs`**: Dedicated logic for handling extension hosts and MCP.

*Boundary Markers*: In the current code, we will rely on commented section headers (e.g., `// --- API ROUTES: WORKSPACE ---`) to delineate these boundaries for Sprint 17 extraction.

### 2. `nvidia_playground.html` Split Plan
**Current Role**: Contains all UI markup, CSS styles, Monaco editor integration, API interaction logic, and state management.
**Proposed Split**:
- **HTML Layouts**: Break down the monolithic structure into smaller template sections (e.g., sidebar, editor, chat panel).
- **`public/css/main.css`**: Extract inline or `<style>` blocks into external stylesheets, potentially separated by components (e.g., `chat.css`, `editor.css`).
- **`public/js/app.js`**: Extract the core application lifecycle and initialization.
- **`public/js/api.js`**: Centralize all `fetch` calls to the backend server.
- **`public/js/components/*.js`**: Isolate component-specific logic (e.g., `inline-edit.js`, `problems-panel.js`).

*Boundary Markers*: Use distinct HTML comment blocks `<!-- SECTION: EDITOR UI -->` and JavaScript comments `// --- API HANDLERS ---` to prep for extraction.

### 3. `agent-core.mjs` Split Plan
**Current Role**: Manages tool invocation, prompting, grounding logic, system message construction, and state tracking.
**Proposed Split**:
- **`agent-prompts.mjs`**: Extract system prompts, rules, and message templates.
- **`agent-tools.mjs`**: Separate tool execution logic (e.g., file reading, cmd execution) from core reasoning.
- **`agent-state.mjs`**: Manage the conversation history and memory.

*Boundary Markers*: Group tool definitions and prompt generation functions with explicit section headers.

### 4. `browser-smoke.mjs` Split Plan
**Current Role**: End-to-end testing, Playwright instrumentation, reporting.
**Proposed Split**:
- **`tests/e2e/core.mjs`**: Base test setup and browser launch configuration.
- **`tests/e2e/suites/*.mjs`**: Separate test suites for specific features (e.g., `chat-suite.mjs`, `inline-edit-suite.mjs`).
- **`tests/utils/reporting.mjs`**: Shared logic for generating test reports and logs.

## Implementation Guidelines for Sprint 17
1. **Iterative Extraction**: Do not extract all at once. Start with the most decoupled logic (e.g., `api.js` from `nvidia_playground.html`).
2. **Preserve Functionality**: Ensure comprehensive test coverage (`browser:smoke`, `agent:audit`) passes after each extraction.
3. **No New Features**: During the extraction phase, freeze new feature development to stabilize the modular boundaries.

## Sprint 16.5 Runtime Hygiene Limitation
- Current hygiene script caps file counts per runtime folder and preserves critical report artifacts.
- Large single-file growth (example: `security/permission-audit.jsonl`) is detected and reported but not auto-rotated yet.
- Safe rotation for append-only `.jsonl` audit logs remains a follow-up hardening task.
