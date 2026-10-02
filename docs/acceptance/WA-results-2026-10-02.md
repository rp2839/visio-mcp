# WA results — 2026-10-02

**All twelve scenarios (WA-01 … WA-12): NOT RUN.**

Reason: the build/CI environment for this branch is a Linux container with no Windows desktop,
Microsoft Visio or Microsoft Word. Neither the WPF app (`Diagram.Windows.slnx` builds but cannot
run here) nor the Office checks could be executed.

What was run instead (not a substitute for acceptance):

- `dotnet test --solution Diagram.Portable.slnx`: VSDX mapping, identity and package-guard tests,
  host VSDX lifecycle tests.
- An independent OfficeIMO.Visio 3.4.4 load of the exported package (`IndependentOracleOfficeImoLoadsExport`).

Next step: run `visio-word-checklist.md` on a workstation with Visio and Word, and replace this file
with observed results and evidence.
