# Audit: NVIDIA Agent IDE x Hybrid ABW Fusion

Date: 2026-04-30
Workspace: `D:\Sandbox\Nvidia`
ABW local source: `D:\Sandbox\skill-Anti-brain-wiki_note`

## 1. Executive Verdict

README.md already states the current product direction clearly enough for an AI coding IDE roadmap:

- build a self-hosted NVIDIA NIM backed AI coding agent IDE,
- prioritize Cursor/Antigravity-like agent UX before trying to clone full VS Code,
- expose a shared backend agent core to Desktop UI, CLI agent, and MCP server,
- split the product into two surfaces: Enterprise Chatbot/Tool Desktop and AI Coding Agent IDE,
- keep file writes and command execution behind trust/approval,
- grow toward extension host, LSP, PTY terminal, semantic context, multi-agent orchestration, and enterprise packaging.

After alignment, README.md now describes the deeper ABW fusion thesis at a strategic level: NVIDIA is the active agent/runtime layer, ABW is the governance, grounded-memory, and reality-checking constitution, and the two systems should be bridged rather than mechanically merged.

The core build philosophy currently reads as:

> "Build an AI coding IDE first, with enterprise chatbot mode later."

But the intended merged-system philosophy should read closer to:

> "Build an enterprise AI operating shell whose hidden power-user layer is a self-developing coding IDE, and whose active cognition runtime is constrained by ABW governance, grounded memory, and reality-checking constitution so it can learn, verify, resume, and safely improve itself."

So the README is now directionally strong for the user's stated ambition: "ABW toàn năng + enterprise chatbot + self-developing NVIDIA IDE agent." Remaining gaps are mostly implementation contracts, ABW canonical roadmap, and e2e bridge proof.

Clarity score for current README as strategic handoff to GPT-5.5: **8.5/10**.

Clarity score for ABW fusion/self-learning governance architecture: **7/10**.

## 2. Evidence From Current NVIDIA Repo

The repo has a real working base for an agent IDE:

- `tools/agent-core.mjs` defines shared workspace tools: file read/list/search, semantic index, git context, pending edits, hunk apply, command jobs, trust state.
- `tools/nvidia-server.mjs` exposes the desktop/backend API, NIM proxy, tools, skill loading, extension host, Open VSX, trust gate, command jobs, pending edits.
- `tools/nvidia-cli-agent.mjs` has sessions, approvals, auto/force modes, tool calling, project scan memory, skill injection, and persistent session files under `.nvidia-agent`.
- `tools/nvidia_mcp.mjs` exposes MCP workspace tools.
- `tools/extension-host.mjs` implements a minimal VS Code compatibility layer and Open VSX install path.
- `nvidia_playground.html` implements Monaco, chat, task/composer panel, pending edits, diff viewer, extension UI, terminal/job UI, context pins, and model probing.

Audit harness result:

- `npm run agent:audit`
- Result: **25/25 passed**
- Report generated: `.nvidia-agent/reports/capability-report-1777526357542.md`

Important caveat: the harness is a capability-presence smoke check, not a deep behavioral/e2e audit. For example, it marks "Brain/Memory" because CLI session load/save exists, but ABW-style `.brain` governance is not present in the NVIDIA root.

## 3. What README Communicates Well

README is strong on product direction:

- It explicitly frames the product as "NVIDIA NIM Agent IDE".
- It states the near-term target: reach Cursor/Antigravity-like AI coding agent UX before full VS Code parity.
- It lists current capabilities with practical percentages instead of pretending the project is complete.
- It separates short-term, mid-term, and long-term roadmap.
- It defines a two-mode product surface:
  - Mode A: Enterprise Chatbot/Tool Desktop
  - Mode B: AI Coding Agent IDE
- It has a concrete Definition of Done for Cursor/Antigravity-like UX.
- It records risk principles: don't clone VS Code first, require trust/approval, use diff review, keep enterprise mode safe.

This is enough for a coding model to continue Sprint 2/Sprint 3 style implementation.

## 4. What README Does Not Yet Make Explicit

README now encodes the ABW-grade governance, grounded-memory, and reality-checking architecture at the philosophy level. The remaining gaps are runtime and contract level:

1. Truth OS layer is stated but not operationalized
   - README names `.brain`, `raw/processed/wiki`, grounded memory, and no-fake-success.
   - It still needs the exact runtime contract: what Node calls, what ABW returns, and how binding status is shown in UI.

2. `.brain` state model is named but not yet integrated
   - NVIDIA uses `.nvidia-agent` for reports/trust/extensions/sessions.
   - It does not yet define which `.brain` files NVIDIA reads/writes directly, which are ABW-owned, and which are read-only to the UI.

3. Continuation Kernel is named but not yet wired
   - README says ABW bridge must not bypass Continuation Kernel.
   - It still needs an implementation path for file budgets, unsafe zones, locked decisions, rollback contracts, approvals, and UI-visible gate results.

4. "Learning without self-poisoning" needs product rules
   - README names grounded memory and no-fake-success.
   - It still needs a promotion path from raw input to trusted knowledge and explicit statuses: grounded, draft, pending grounding, disputed, stale, missing.

5. ABW is present as skills, but not as runtime
   - `skills/abw-*.md` exists in NVIDIA repo.
   - But NVIDIA root does not currently contain:
     - `scripts/continuation_gate.py`
     - `scripts/abw_runner.py`
     - `scripts/abw_accept.py`
     - `wiki/`
     - `raw/`
     - `processed/`
     - `.brain/`
   - Therefore ABW is currently a copied workflow surface, not an integrated reasoning/governance subsystem.

6. Enterprise chatbot mode needs ABW-backed behavior
   - README says Enterprise mode hides Explorer/Terminal/Extensions/Diff/Git.
   - It also needs explicit UX requirements for citations, gaps, disputed answers, approval flows, and audit trails.

## 5. ABW Core Philosophy From Local Project

The local ABW repo is not just a set of prompts. Its core idea is a governed reasoning operating discipline:

- `.brain/`: operational memory, session state, blockers, handover, step history, budgets, knowledge gaps.
- `wiki/`: durable grounded knowledge, not task state.
- `raw/`: source material.
- `processed/`: normalized extraction/manifest layer between raw and wiki.
- NotebookLM MCP / grounding backend: verification and deep synthesis layer.
- Router: `/abw-ask` chooses fast query, deep query, bootstrap, or governed resume path.
- Tier 1: fast wiki-first answer, no hallucination when evidence missing.
- Tier 2: bounded deliberative query over wiki/raw with self-critique and repair.
- Tier 3: greenfield bootstrap, only assumptions/hypotheses/validation backlog, no fake facts.
- Tier 4: governed continuation via Continuation Kernel.
- Continuation Kernel: controls what the agent may safely do next, using unsafe zones, locked decisions, effective budget, knowledge gaps, rollback contract, and approval gates.
- Strict No Fake Success rule: if grounding is down, mark draft/pending, never pretend grounded.

This is exactly the missing governance and reality-checking constitution for a self-developing agent IDE. NVIDIA remains the active agent/cognition runtime; ABW supplies the rules, grounded memory discipline, and action constraints that keep that runtime aligned with evidence and safe execution.

## 6. Strategic Compatibility

The two systems are highly compatible because they solve different layers:

| Layer | NVIDIA Agent IDE | ABW |
|---|---|---|
| User surface | Desktop UI, CLI, MCP, Monaco, extension host | CLI/workflow discipline |
| Tool execution | Workspace file tools, command jobs, pending diffs | Governance and routing rules |
| Coding UX | Composer, diff, terminal, extension host | Safe continuation and audit |
| Memory | CLI sessions, project scan, `.nvidia-agent` state | `.brain` operational memory |
| Knowledge | Semantic lexical index, git context | `raw/processed/wiki`, grounded knowledge |
| Safety | Workspace trust, secret redaction, approval | unsafe zones, locked decisions, rollback, no fake success |
| Enterprise readiness | two-mode shell, branding direction | grounded private knowledge and auditability |

The natural fusion is:

> NVIDIA is the active agent runtime capable of cognition, action, and self-development (UI, IDE, terminal, tools). ABW is the constitutional governance layer: verified memory, rules of action, reality-checking, audit, and anti-destruction mechanisms as the agent evolves. They are bridged, not mechanically merged.

## 7. Potential Breakthrough Idea

The strongest combined product concept:

### "ABW-governed Self-Developing Enterprise Agent IDE"

A normal enterprise user sees a safe chatbot/tool desktop:

- upload documents,
- ask questions,
- generate reports,
- run approved workflows,
- see citations/gaps/conflicts,
- never touch terminal/code by default.

A power user unlocks IDE mode:

- Monaco editor,
- terminal/job manager,
- diff review,
- extension host,
- agent composer,
- ABW continuation state.

The agent can improve its own codebase, but only through ABW continuation governance:

1. user asks for improvement,
2. ABW router classifies request,
3. if knowledge is missing, ABW logs/ingests gap first,
4. if action is needed, Continuation Kernel selects one safe next step,
5. NVIDIA agent implements via pending diff,
6. user reviews diff/test result,
7. outcome is recorded to `.brain/step_history.jsonl`,
8. lessons are learned only through approved promotion rules.

This creates a rare architecture: not merely a chatbot with tools, and not merely an IDE with chat, but a governed self-improving enterprise agent shell.

## 8. Main Technical Limits

1. Runtime mismatch
   - NVIDIA is Node/Electron/HTML.
   - ABW is Python package + scripts + workflow markdown.
   - The fusion needs an explicit ABW bridge, not just copied markdown skills.

2. State model conflict
   - NVIDIA uses `.nvidia-agent`.
   - ABW uses `.brain`, `raw`, `processed`, `wiki`.
   - Recommendation: keep both, but define boundaries:
     - `.nvidia-agent`: app runtime, trust, extension registry, UI sessions, reports.
     - `.brain`: governed project reasoning/action state.
     - `wiki`: durable grounded enterprise/project knowledge.

3. Current semantic index is not ABW grounding
   - NVIDIA `semantic_index` is lexical/chunk scoring.
   - ABW grounding requires evidence status, citations, contradiction tracking, gap logging.

4. Current agent self-healing is not governed enough
   - README mentions self-healing.
   - ABW requires bounded steps, rollback contracts, unsafe zones, locked decisions, and step history.

5. Current skills may contain mojibake
   - Some copied Vietnamese ABW skill files in NVIDIA repo display mojibake.
   - The source README is valid UTF-8, but several skill files should be re-synced or repaired before becoming source of truth.

6. Extension host security is early
   - README already admits this.
   - For enterprise/self-developing workflows, extension JS needs a separate process/sandbox and policy model.

7. Audit harness is shallow
   - It verifies capability presence and syntax.
   - It does not prove recovery, governance, data grounding, rollback, extension isolation, or enterprise knowledge safety.

## 9. README Alignment Status

README has now incorporated the core philosophy. The earlier recommendation was:

### Core Build Philosophy

This project is not only an AI coding IDE. It is an enterprise agent shell with two faces:

1. Enterprise mode: safe chatbot/tool desktop for business users.
2. IDE mode: unlocked power-user workbench for coding, debugging, extensions, terminal, and self-improvement.

Both modes share one agent core. The long-term differentiator is an ABW-style governance and grounded-memory constitution:

- `.brain` stores operational state, continuation state, knowledge gaps, handover, and step outcomes.
- `raw/processed/wiki` store grounded enterprise/project knowledge.
- The agent may answer from trusted knowledge, bootstrap assumptions when knowledge is absent, or request ingestion when evidence is missing.
- Writable self-improvement must pass a Continuation Kernel gate before execution.
- No model may claim grounded success when grounding, tests, or acceptance gates are missing.

README also now includes an architecture section equivalent to:

### ABW Fusion Target Architecture

```text
Model providers: NVIDIA NIM / Gemini / local model
        ↓
NVIDIA Agent Runtime: UI, CLI, MCP, IDE, terminal, tools, self-code loop
        ↓
ABW Constitutional Layer: governance, grounded memory, continuation gate, audit
        ↓
Enterprise Reality Layer: SOP, QA, manuals, ERP/MES/QMS, production logs
```

Still add or enforce this DoD item:

- A self-improvement task is only considered done when the change has an accepted diff, tests/audit result, `.brain/step_history.jsonl` entry, and no open blocking knowledge gap.

## 10. Recommended Fusion Roadmap

### Phase 0: Documentation Alignment

- Keep README and this audit aligned with ABW Fusion Target Architecture.
- Create or update the canonical ABW README/roadmap in `D:\Sandbox\skill-Anti-brain-wiki_note`.
- Define `.nvidia-agent` vs `.brain` boundaries.
- State the self-learning/no-fake-success policy.
- Maintain a shared integration journal that separates NVIDIA runtime work, ABW engine work, bridge work, and enterprise deployment work.

### Phase 1: Runtime Bridge

- Add ABW bridge API in Node:
  - detect ABW workspace,
  - run `abw ask`,
  - run `abw doctor`,
  - run continuation gate,
  - read `.brain` status,
  - surface knowledge gaps and next safe step in UI.

### Phase 2: State Bootstrap

- Add command/UI action: "Initialize ABW Governance Workspace".
- Create `.brain`, `raw`, `processed`, `wiki` only when user opts into ABW workspace mode.
- Keep `.nvidia-agent` app state separate.

### Phase 3: Governed Self-Improvement

- Route "improve this IDE" or "continue project" requests through `/abw-resume`.
- Require selected safe step before code edits.
- Bind pending diff review to ABW step id.
- Append execution outcome to `.brain/step_history.jsonl`.

### Phase 4: Enterprise Knowledge Mode

- Add document ingestion into `raw/`.
- Promote to `processed/` and `wiki/` with citation/gap/conflict status.
- Enterprise answers must expose binding status: grounded, draft, pending grounding, disputed, or missing.

### Phase 5: Evaluation Harness

- Expand `npm run agent:audit` beyond smoke checks:
  - ABW workspace detection,
  - continuation gate pass/block cases,
  - no fake grounded answer when wiki is empty,
  - pending diff linked to step id,
  - audit report generated,
  - rollback contract exists,
  - enterprise mode cannot access terminal/write tools unless IDE unlocked.

## 11. Direct Answer To The User's Question

Has README written the project's build philosophy clearly?

Answer after alignment: **mostly yes at the strategic level, still incomplete at the runtime-contract level**.

It is now clear as a roadmap for building a Cursor/Antigravity-like NVIDIA Agent Runtime with enterprise/IDE modes, and it now states the larger philosophy: NVIDIA is the active agent runtime while ABW is the governance, grounded-memory, and reality-checking constitution. What remains incomplete is not the philosophy, but the executable contract: bridge API, ABW-owned files, UI states, gate semantics, enterprise knowledge lifecycle, and e2e verification.

The README should continue evolving from "roadmap of IDE capabilities" into an executable constitution of the system:

- what the system is,
- what it may know,
- how it proves knowledge,
- how it may act,
- how it learns,
- how it safely changes itself,
- how enterprise users are protected from power-user tools.

## 12. Suggested Prompt For GPT-5.5

Use this audit as source context. Analyze whether two projects should be merged:

- NVIDIA Agent IDE at `D:\Sandbox\Nvidia`
- Hybrid ABW at `D:\Sandbox\skill-Anti-brain-wiki_note`

Main hypothesis:

NVIDIA provides the active agent/cognition runtime: Desktop UI, CLI, MCP, Monaco, extension host, workspace tools, pending diffs, command jobs, model routing, and the self-development loop.

ABW provides the governance, grounded-memory, and reality-checking constitution: `.brain`, `raw/processed/wiki`, adaptive router, grounded query, bootstrap reasoning, continuation kernel, unsafe zones, locked decisions, rollback contract, no fake success.

Please evaluate:

1. Can these systems be fused without destroying either architecture?
2. Should `.nvidia-agent` and `.brain` remain separate, or should one absorb the other?
3. What is the minimal bridge architecture between Node/Electron and Python ABW?
4. What is the best product framing: IDE-first, enterprise-chatbot-first, or dual-shell?
5. What is the technical limit of self-improvement with ABW governance?
6. What is the biggest breakthrough possible from this fusion?
7. What are the top 10 engineering risks?
8. What is a 4-week implementation plan that maximizes leverage and avoids overbuilding?

Important constraints:

- Do not fake grounding.
- Do not let enterprise mode expose terminal/write tools by default.
- Do not let self-improvement bypass diff review, tests/audit, rollback, and `.brain` history.
- Do not treat copied ABW markdown skills as full integration; real runtime scripts and state must exist.
