# G1 manual checklist (Windows + desktop Visio + Word)

Status: **NOT RUN**. No Windows/Office machine available (Q1).

Input: `generated.vsdx` (from `dotnet run --project spikes/vsdx -- --output ...`).

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Open `generated.vsdx` in Visio | No repair prompt | NOT RUN |
| 2 | Edit rectangle text and fill | Independent editable object | NOT RUN |
| 3 | Move ellipse | Connector stays glued and reroutes | NOT RUN |
| 4 | Change picture (Change Picture) | Picture stays a distinct object | NOT RUN |
| 5 | ShapeSheet → User.AgentId | `6f1c2b9e-…` present | NOT RUN |
| 6 | Copy/paste rectangle, save | Duplicate User.AgentId; reader regenerates the copy | NOT RUN |
| 7 | Rotate 33°, hide/lock layer, print flag | Record observed layer semantics | NOT RUN |
| 8 | Save as `visio-saved.vsdx`; run `dotnet run --project spikes/vsdx -- --read visio-saved.vsdx` | IDs, glue, image identity read back; check whether `source1.svg` relationship survived | NOT RUN |
| 9 | Insert into Word as object, activate, edit, save, reopen, reactivate | Editable Visio object | NOT RUN |

Record Windows/Visio/Word versions and screenshots next to this file.
