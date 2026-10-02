# Agentic diagram editor design

Date: 2026-10-02. Status: **design complete and jointly reviewed; ready for user review**.
Authors: Codex and Claude,
collaborating through the agent broker.

The goal is a Windows desktop editor for technical/business diagrams in which a
human and an external LLM make incremental edits to the same persistent objects.
Success requires practical GUI editing, deterministic atomic agent patches, and
editable native VSDX interoperability verified in Visio and Word. This design refines
[the supplied specification](../../agentic-visio-mvp-spec.md); it does not replace
its requirements or expand its non-goals.

| Document | Sections | Primary author |
|---|---|---|
| [Architecture](architecture.md) | D1: boundaries, choices, contracts | Codex |
| [Editor and commands](editor-and-commands.md) | D2–D4: model, GUI, scripts, visual feedback | Codex |
| [Host and interoperability](host-and-interoperability.md) | D5–D7: host/MCP, VSDX, assets/recovery | Claude, integrated by Codex |
| [Feasibility and acceptance](feasibility-and-acceptance.md) | D8: gates, evidence, delivery | Both |
| [Questions and decisions](QUESTIONS.md) | Agreements, disagreements and user review items | Both |

Progress is maintained separately for [design](../../DESIGN_PROGRESS.md) and
[implementation](../../IMPLEMENTATION_PROGRESS.md). A drafted design or dependency
README is not proof that a feasibility gate has passed.

Claude authored the host/native-format sections and reviewed the complete integrated
design after the spending limit was reset. Codex incorporated the agreed resolutions
and final consistency corrections. [QUESTIONS.md](QUESTIONS.md) records the resolved
choices, spec refinements and remaining user/environment questions. Implementation
has not started; library feasibility and real Visio/Word acceptance remain M0 work.

The [implementation plan](../superpowers/plans/2026-10-02-agentic-diagram-implementation.md)
expands the packages into proposed files, contracts, test cycles and verification
steps. Claude reviewed it with corrections that Codex incorporated; the exact verdict
and correction record are linked from the implementation progress file.
