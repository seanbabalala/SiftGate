# One shutdown owner for requests, accounting and telemetry

A successful HTTP response, especially a completed SSE body, can precede the last
accounting write. The process must not exit while that work is still running.
Enabling telemetry must not introduce another signal handler that bypasses this
request/accounting drain.

## Ordering

The Gateway's single SIGTERM/SIGINT owner performs the following under the
configured `server.shutdown_timeout_ms` deadline:

1. Stop the listener watchdog and begin closing incoming HTTP connections.
2. Let Nest module-destroy hooks close upgraded Realtime transports. Do not await
   HTTP close before those hooks: an upgraded socket can keep it pending.
3. At HTTP-adapter disposal, await HTTP completion and tracked request/accounting
   promises, then drain the pipeline's pending call-log and route-trace writes.
   Database shutdown hooks follow this boundary. Nest's earlier
   `beforeApplicationShutdown` hook alone is insufficient: its queues may have
   been empty while a request was still completing accounting.
4. After `app.close()` completes, await the optional telemetry SDK's shutdown.
   This exports telemetry generated during the drain as well as closing its
   exporters. Only then report successful process exit.

The telemetry initializer still executes before Nest/HTTP imports so instrumentation
can start early. It exports an idempotent `shutdownTelemetry()` promise instead
of registering its own signal handlers or calling `process.exit`. Disabled telemetry
is a no-op. A constructed SDK whose startup failed can still be cleaned up.
SDK shutdown rejection or expiration of the overall deadline remains a nonzero
exit, never a false report that all accounting drained successfully. A telemetry
failure after accounting has completed does not reverse that accounting.

This does not guarantee success after arbitrary power loss or a hard kill.
Durable settlement/outcome recovery remains a separate part of the pricing
contract. It also does not restart the production Gateway or enable a real
telemetry destination.

## Evidence

An isolated pre-change regression executed the real initializer with fake SDK
transports and observed two competing signal registrations. The fixed tests verify
no registrations from that module, one shared shutdown promise, disabled/startup-
failure behavior, rejection propagation, and the actual main shutdown wiring.
A delayed accounting promise and a delayed exporter promise prove that main does
not exit early; repeated signals do not invoke duplicate shutdown.

The existing real-Nest upgraded-socket test separately verifies the transport →
HTTP/accounting → database lifecycle. An actual compiled-main smoke runs JSON and
SSE requests with the real installed telemetry SDK, local mock upstream and local
trace collector. The test-only metrics listener binds loopback, and a transport
guard denies non-fixture HTTP destinations. Immediate shutdown after the final
response must preserve every receipt/budget/log and export traces before exit;
the exporter listener must be absent afterward.

This telemetry smoke is correctness evidence, **not a baseline performance pass**.
Full HTTP performance and final image/source acceptance remain separate gates;
see [performance results](pricing-performance.md).

## Late queued logs on short connections

A separate compiled-main regression pauses receipt retention, begins shutdown,
waits for the pipeline's early shutdown hook, then lets the request finish. The
client sends `Connection: close`, so an idle keep-alive connection cannot mask an
incomplete drain. Before the fix, the process exited successfully with the exact
fee committed but no call log. The failed raw result remains recorded.

The corrected shutdown path waits for `drainPendingLogWrites` after request
completion. A second pause on the late log writer proves that HTTP-adapter
disposal cannot finish until that write completes. Both legacy-logical and
actual-expense fixtures then exit cleanly with one receipt, one debit and one
log; no model work is retried. The four retention/delivery shutdown scenarios
also pass. These are isolated fault-injection checks, not production restarts
or a guarantee against arbitrary storage failure or hard process termination.
