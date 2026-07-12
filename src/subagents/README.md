# subagents

**Purpose:** Sub-agent orchestrator — spawn and collect results from child agent
sessions (research, memory-scan, report-analysis, medical). Runs on the same AgentLoop
class with a subagent prompt mode. All workers are read-only on memory; writes happen
in the parent turn only.

**Public API (index.ts):**
- `SubagentRunner` — `spawn(profileId, spec)` and `collect(runId)` for managing
  child agent sessions. Worker definitions live in `kinds/` directory.

**Dependencies:** ports (id-gen, clock), providers (LLMProvider via AgentLoop)

**Extraction notes:** Orchestration only; tool enforcement is handled by the registry.
