# Actual-cost settlement across media tasks

A media receipt records one provider attempt. A reservation can also contain
other asynchronous media tasks or earlier synchronous attempts. Completing one
task is not proof that every asynchronous member has finished.

## Receipt custody before finality

Each terminal task stores its original-price computation, original attempt
receipt, processed observation and acknowledgement audit in one ledger transaction.
While another asynchronous member is still live or lacks an acknowledged initial
receipt, the reservation remains open and no actual-cost debit is applied.

A correction received during that interval remains durably prepared and
unprocessed. Processing returns a deferred result rather than spinning, creating
a premature closure, dropping evidence or resubmitting the generation.

After every asynchronous member has an acknowledged terminal receipt, the ledger
records a bounded, ordered authority list. The first task is the anchor; additional
members are stored as sibling references. Earlier synchronous attempts remain in
the complete attempt population and contribute their costs, but are not
asynchronous authorities. These references are storage-only and are rejected by
the runtime receipt wire parser.

## Budget readiness and recovery

Budget readiness checks every member's retained observations, signed event head,
review dispositions and ordering authority. An unprocessed observation or
unresolved review keeps the original reservation pending. The recovery fingerprint
includes this whole-reservation media custody, so new sibling evidence invalidates
an old administrative preview even when the anchor's receipt has not changed.

Once the entire cohort has usable actual-cost evidence, the debit and all task
completion states share one transaction. Failure to update a sibling rolls back
the new debit, closure and current receipt acknowledgement together; previously
committed sibling receipts remain intact. Background budget reconciliation updates
all terminal media tasks, without requiring another poll of the original anchor.

Replaying a receipt checks its immutable attempt/correction effect and audit.
Replaying a closure checks every sibling, not just the anchor. Lost authority or
acknowledgement fails closed rather than creating another budget charge.

## Operator review

A terminal actual-cost receipt can legitimately coexist with a reserved budget.
A verified, non-quarantined closed cohort allows review of retained media evidence
in that state; the legacy logical-settlement restriction remains unchanged.
The review basis incorporates the cohort's accounting fingerprint.

Rejecting evidence changes custody only. It neither creates a usage fact nor runs
financial processing; ordinary background reconciliation can subsequently settle
the already-retained evidence. Status responses distinguish successfully retained
custody from financial processing that is still pending. Known costs from failed
or cancelled work are not discarded.

## Verification boundary

Tests use synthetic prices, isolated SQLite/PostgreSQL and mock suppliers. HTTP
coverage seeds a second retained dispatch, then exercises both real status routes;
it does not claim that the generation API itself dispatched a parallel batch.
No supplier request is repeated to recover accounting.

This document describes the implemented cohort path, not complete pricing Goal
readiness. All-operation media behavior, original FX/lookup/fault coverage,
actual-cost Realtime, performance and final deployment artifacts still require
their corresponding acceptance evidence. No production migration or restart is
authorized by these checks.
