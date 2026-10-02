# I03 — stdio MCP → bounded pipe → test host (G3)

Disposable probe. `spikes/ipc` holds the frame codec, pipe client and a handshake-first host stub
(`app.hello`, `doc.summary`). `spikes/mcp` is a real stdio MCP server built with the official C#
SDK (`ModelContextProtocol` 2.2.0 + `Microsoft.Extensions.Hosting` 10.0.10). It exposes
`get_document_summary(documentId, sessionId)` and forwards over the pipe.

| Behaviour | Evidence |
|---|---|
| 4-byte LE length framing, exact partial reads (3-byte chunks) | `PartialReadRoundTrips`, `TruncatedFrameIsRejected` |
| >32 MiB declared length rejected before any payload allocation | `FrameLengthAbove32MiBRejectedBeforeAllocation` (allocation counter = 0) |
| 8 MiB frame round trip | `EightMiBFrameRoundTrips` |
| First frame must be `app.hello`; otherwise `invalid_request` and close | `NonHandshakeFirstFrameRejected` |
| Session scope enforced (`session_mismatch`) | `HandshakeThenSummary` |
| Missing host → `not_running` (shim never launches the app) | `MissingHostIsNotRunning`, `SdkToolReportsNotRunningWhenHostAbsent` |
| Real SDK client → shim process → pipe → host structured result | `RealSdkToolRoutesThroughPipe` |
| Host dies after dispatch → `disconnected`, outcome `unknown` (no rollback claim) | `DisconnectMidCallReportsUnknownOutcome` |
| Stdout carries only JSON-RPC; logs go to stderr | `StdoutContainsOnlyMcp`, `docs/m0/evidence/G3/{stdin,stdout,stderr}` |

```sh
dotnet test spikes/ipc.tests/IpcProbe.Tests.csproj   # red 4/11 → green 11/11 (Linux)
```

Red run: size cap, handshake enforcement and not_running mapping were left out; those tests
failed on assertions, then passed once implemented. (`PartialReadRoundTrips` also failed red on a
test bug: it compared raw JSON text, which differs only in `é` escaping. It now compares
semantically.)

## Limits of this evidence

Linux .NET implements named pipes as Unix domain sockets. `PipeOptions.CurrentUserOnly` is set,
but Windows ACLs, rejecting a second user and a logon-session-scoped pipe name were **not
tested**. They need the Windows run (I05/Q1). Timings were not recorded as gate evidence.
