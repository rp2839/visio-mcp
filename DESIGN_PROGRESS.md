# Design progress

Updated: 2026-10-02 (Europe/London).

Scope: turn [the supplied specification](agentic-visio-mvp-spec.md) and
[introductory research](viso-app.intro) into a sectioned, jointly reviewed design.
Product implementation is a later activity. The original specification remains unchanged.

Status meanings: `in progress` = drafting; `review` = drafted, awaiting final
consensus/user review; `complete` = authored and reviewed by Codex and Claude; `blocked` = recorded
decision prevents completion. `complete` does not mean feasibility has been proven
or that the user has approved implementation.

| ID | Design section | Author | Reviewer | Spec sections | Status | Deliverable |
|---|---|---|---|---|---|---|
| D1 | Scope, architecture, contracts and dependency choices | Codex | Claude | 1–4, 19–20, 24–26 | complete | docs/design/architecture.md |
| D2 | Canonical model, identity, transactions, history | Codex | Claude | 5–7, 10, 15 | complete | docs/design/editor-and-commands.md |
| D3 | GUI and canvas adapter | Codex | Claude | 6, 8, 18 | complete | docs/design/editor-and-commands.md |
| D4 | DrawScript, rendering and layout inspection | Codex | Claude | 9, 12, 14, 21 | complete | docs/design/editor-and-commands.md |
| D5 | Windows host, WebView2 bridge and MCP/IPC | Claude | Codex | 4, 11, 17, 19 | complete | docs/design/host-and-interoperability.md |
| D6 | VSDX adapter, fidelity and round-trip policy | Claude | Codex | 7, 13–14, 21 | complete | docs/design/host-and-interoperability.md |
| D7 | Assets, persistence, recovery and input limits | Claude | Codex | 5.8, 8.2, 16–17 | complete | docs/design/host-and-interoperability.md |
| D8 | Feasibility gates, acceptance and delivery dependencies | Claude + Codex | Both | 18, 21–23, 27 | complete | docs/design/feasibility-and-acceptance.md |

## Checklist

- [x] Read both source documents completely.
- [x] Check local project: source documents only; no existing product implementation.
- [x] Discover Claude through the agent broker; confirm read-only worker access.
- [x] Assign bounded design sections and shared interface assumptions.
- [x] Draft all sections and map all 20 definition-of-done criteria to deliverables.
- [x] Cross-review all design sections; resolve R1–R4 and final consistency corrections.
- [x] Record disagreements, defaults and user-owned decisions.
- [x] Check local links, fenced blocks, section/package IDs and progress consistency;
  review requirement coverage and record remaining policy contradictions explicitly.
- [x] Publish a reviewable design summary.

## Collaboration record

- Claude task `e1a324f4-7b00-42c3-a434-c6387ae292fe`: D5–D7 and the M0/Windows
  part of D8. Codex writes D1–D4 and integrates the returned Markdown.
- Broker workers cannot write project files; authorship is preserved in the design,
  and Codex materialises the results locally.
- User authorises proceeding with the design and recording unresolved questions
  for later review; individual section approvals are not required during drafting.
- Git metadata is not usable as a repository in this workspace; documents are
  written locally without claiming a commit.

## Current outcome

All eight design sections are complete and jointly reviewed. R1–R4 are resolved:
explicit mutation identity, reconnect-safe transaction deduplication, a bounded
human-gesture admission gate and canonical-only derived group bounds. Group rotation
uses an explicit delta; asset versions use full hashes. Q1–Q3 in QUESTIONS.md are
user/environment policy items, not remaining cross-agent disagreements.

## Resumed collaboration

The original task produced two artifacts before its final turn hit the spending
limit ($3.02 reported). Its historical review remains
[claude-review.md](docs/design/collaboration/claude-review.md).

After the user reset the limit, task `158c4e3e-244f-4400-b39d-7aa90f924884` reviewed
R1–R4, all integrated corrections and D8. Claude agreed with refinements, preserved
in [claude-consensus-review.md](docs/design/collaboration/claude-consensus-review.md).
Codex integrated them and fixed admission ordering, queue-head cache lookup and
group bounds that could otherwise depend on external connector routes.

Task `06f06e9e-afd5-4dd6-aa78-812f7edb022b` performed a bounded final consistency
check. It accepted the two precision choices and identified one admission-time
revision-check conflict plus rotate/reconciliation wording gaps. Codex applied the
prescribed edits and verified them locally; the exact conditional verdict is in
[claude-final-consistency.md](docs/design/collaboration/claude-final-consistency.md).
No claim is made that Claude ran a further review after those exact corrections.

Implementation remains not started, including feasibility probes. User review and
M0 evidence are still required before production implementation. No git commit,
product build, runtime test or Windows acceptance result is claimed.

## Verification

Final documentary verification passed: 11 Markdown files, all local links resolving,
balanced code fences, eight complete design section IDs and 18 unique implementation
packages marked not started. Checks confirmed scope-only admission, queue-head cache
before revision, explicit rotation/pivot rules, canonical-only group geometry,
full-hash asset versions, blob durability and state-only cross-session recovery.
Coverage maps all 20 source completion criteria. This is not feasibility proof.

## Review entry points

- [Design overview](docs/design/README.md)
- [Questions and decisions](docs/design/QUESTIONS.md)
- [Implementation progress](IMPLEMENTATION_PROGRESS.md)
- [Implementation plan](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md)

## Implementation planning follow-up

The user requested an implementation design and Claude review. Codex drafted a
four-document executable plan covering the 18 implementation packages. Broker task
`7a968559-bffe-4a68-bbf1-150eaf5f4323` returned approve with corrections. Codex
integrated the eight important findings and minor coverage/type fixes, then checked
package coverage, dependencies, links/fences and corrected interfaces. Architecture
status remains complete; product implementation remains not started. The exact
[review](docs/design/collaboration/claude-implementation-plan-review.md) and
[disposition record](docs/design/collaboration/implementation-review-disposition.md)
preserve what Claude reviewed and what Codex changed afterwards.
