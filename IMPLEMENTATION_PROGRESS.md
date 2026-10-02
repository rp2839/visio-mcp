# Implementation progress

Updated: 2026-10-02 (Europe/London).

Status: **I00 implemented and reviewed by Codex (approve with corrections; corrections applied)**; all other packages not started. This file splits future implementation into bounded work
packages. It is a progress and dependency register, not a claim that feasibility
spikes, builds, tests or Windows acceptance have run.

The current request is to create an implementation design and have Claude review it.
The [implementation plan](docs/superpowers/plans/2026-10-02-agentic-diagram-implementation.md)
has been reviewed by Claude; Codex incorporated the requested corrections. Product
implementation is still not started.
No product scaffolding or dependencies are needed for this request.
Package ownership below is proposed: Claude currently
has read-only broker access, so a future implementation session must either enable
write-capable delegation or have Claude return reviewable patches for Codex to apply.

| ID | Milestone / package | Proposed implementer | Depends on | Status | Exit evidence |
|---|---|---|---|---|---|
| I00 | Freeze shared contracts, dependency versions/licences for isolated probes | Claude (implemented); Codex review | Design review | done (Codex review 68fcf783 corrections applied) | `spikes/contract-tests` 16/16 pass; versions in `docs/m0/dependencies.json` |
| I01 | M0: OfficeIMO editable VSDX round-trip harness | Claude design / Codex execution | I00 | not started | Generated and Visio-saved fixtures; glue/IDs/images verified |
| I02 | M0: maxGraph interaction and PNG probe | Codex | I00 | not started | Move/resize/connect/image and render demonstrated |
| I03 | M0: stdio MCP → pipe → test host probe | Claude design / Codex execution | I00 | not started | Tool result, rejection, disconnect and framing evidence |
| I04 | M0: WebView2 → live frontend operation probe | Codex | I00, I02 | not started | Visible change plus matching document revision |
| I05 | M0: Windows Visio/Word acceptance and backend decision | Codex + Windows tester | I01–I04 | not started | All four probes pass; Visio/Word manual evidence |
| I10 | M1: minimal canonical store, transaction engine, inverse history | Codex | I05 | not started | Atomic rollback, revision race, patch preservation tests |
| I11 | M1: WPF/WebView2 shell and JSON debug save/load | Codex; Claude review | I05, I10 | not started | Startup, ready handshake and file round-trip |
| I12 | M1: one-page canvas, basic elements and inspector | Codex | I10, I11 | not started | GUI commands use store; glue and undo verified |
| I20 | M2: full model and operations, groups, arrange, target resolution | Codex | I12 | not started | Every mutation tested with unaffected-object assertions |
| I21 | M2: DrawScript parser/compiler and transaction drawer | Codex; Claude review | I20 | not started | Script/API equivalence and source error locations |
| I30 | M3: production IPC routing and stdio MCP tools | Codex; Claude review | I11, I20, I21 | not started | Live GUI control, retry/conflict/session isolation |
| I31 | M3: render snapshots, layout checks and change queries | Codex | I12, I20, I30 | not started | Revision-labelled previews and bounded history recovery |
| I40 | M4: production VSDX mappings and compatibility diagnostics | Codex; Claude review | I01, I20, I30, I31 | not started | Feature matrix and supported-subset round-trip tests |
| I41 | M4: Visio/Word manual acceptance suite | Windows tester + Codex | I40 | not started | Editable objects, glue, UUID retention, Word activation |
| I50 | M5: multipage/layers and approved asset library | Codex; Claude review | I20, I40 | not started | Page/layer operations; one-logo and global-replace tests |
| I51 | M5: durable recovery, security limits and failure handling | Codex; Claude review | I11, I30, I40, I50 | not started | Crash recovery and hostile-input boundary tests |
| I52 | M5: performance measurements and complete demo | Codex + Windows tester | I31, I41, I50, I51 | not started | Spec §23 demo; every §27 criterion evidenced |

Input validation and safe IO are introduced in the first package that accepts
input, then tested and hardened in I51. They are not postponed until M5.
M1 includes a minimal command engine because its GUI and undo must already use
canonical transactions; M2 expands it instead of introducing a competing engine.

## Evidence register

Planning evidence: four plan documents (overview, M0, editor, host/integration),
covering all 18 packages. Claude review task `7a968559-bffe-4a68-bbf1-150eaf5f4323`
returned **approve with corrections**. Codex incorporated all eight important
findings and the minor contract/coverage corrections. The exact verdict is preserved
in [Claude's review](docs/design/collaboration/claude-implementation-plan-review.md),
with [dispositions](docs/design/collaboration/implementation-review-disposition.md).
No additional post-correction Claude verdict is claimed.

Document verification passed: all packages covered once, no dependency cycles,
all local links/code fences valid, review-required interfaces/test cases present
and stale field/interface names removed. Production tasks retain their not-started
status; these checks are not runtime, build or feasibility evidence.

I00 (2026-10-02, Fedora 44, Node 24.21.0): in `spikes/contract-tests`, `npm test` went red
(6/8 failed on a placeholder schema) then green (8/8). Codex review task
`68fcf783-d9e6-430e-8423-4bab0b5cfe95` returned **approve with corrections** (2 important,
4 minor), all applied: the schema is now request-only and rejects scope in `params` for every
method; the regression tests went red (1/16) on the old schema, then `npm ci && npm test` passed 16/16. Probe versions, licences and
hashes are in [dependencies.json](docs/m0/dependencies.json); run details in
[environment.json](docs/m0/environment.json). .NET was not installed, so only npm deps were
installed; NuGet/.NET entries are pinned from registry metadata, not built.

For each completed package record: exact dependency
versions, commands, environment, fixture paths, observed results and remaining
limitations. Manual checks include Windows, Visio and Word versions and screenshots
or an acceptance report. Automated reopening alone cannot satisfy desktop acceptance.

## Design outcome and remaining dependencies

R1–R4 are resolved in [QUESTIONS.md](docs/design/QUESTIONS.md). Their implementation
checks cover explicit session scope, deduplication before revision validation,
per-connection FIFO gesture admission and canonical-only group bounds. Document
completion does not mark an implementation package complete.

The architectural design and reviewed implementation plan are ready for user review.
Q1 identifies the Windows/Visio/Word acceptance
environment; Q2 retains the source's best-effort lossy-import policy; Q3 concerns SVG
fallback only if native support fails. M0 functional evidence remains the production
gate. No dependency was installed and no feasibility probe was run during design.

## Current dependencies

- [Design progress](DESIGN_PROGRESS.md)
- [Feasibility and acceptance design](docs/design/feasibility-and-acceptance.md)
- [Questions for later review](docs/design/QUESTIONS.md)

Linux can support portable frontend/model tests and some .NET library work. WPF,
WebView2 and genuine Visio/Word interoperability require a Windows acceptance environment.
