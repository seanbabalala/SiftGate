# Auxiliary writers and pricing transaction isolation

Implemented in the isolated candidate, not deployed. This closes the enumerated
batch-job, evaluation, prompt-template, agent-profile, shadow-result,
compatibility-result and Dashboard cleanup boundaries. It is not a claim that
all supplier lifecycles or every plugin/external SQL writer are now covered.
See the full [Goal Spec](pricing-engine-goal-spec.md) and
[progress](pricing-engine-progress.md) for remaining acceptance requirements.

## Why these writers participate

The SQLite TypeORM DataSource uses one connection. An unrelated asynchronous
repository operation must not accidentally read an uncommitted value, enter an
existing transaction/savepoint, or lose its supposedly successful write when a
pricing transaction rolls back. These services now use the same coordinated
queue as the cost ledger. Writes receive transaction-scoped repositories; ordinary
reads of their data also wait outside unrelated SQLite transactions.

The shared `withCoordinatedRepository` callback is deliberately database-only.
It must not wrap an entire provider request, PipelineService execution, telemetry
callback or another globally coordinated service. An existing active transaction
is joined only through an explicitly scoped repository, not by inspecting the
global connection and assuming its unrelated transaction belongs to the caller.

On PostgreSQL the global SQLite queue is not used. Short transactions, row locks
and schema-qualified advisory locks protect the specific read/modify/write or
read/create decisions. The tests use independent DataSources for concurrent
PostgreSQL writers, not merely separate promises sharing one manager.

## Boundaries

| Writer | Database boundary | Work outside that boundary |
| --- | --- | --- |
| Batch job store | Metadata creation, fresh-row provider update, cancellation; scoped reads | Provider create/retrieve/cancel/download |
| Legacy batch call log | One metadata-only log save | Budget service call and telemetry observation |
| Evaluation import | Dataset metadata, run and all sample metadata commit or roll back together | Report formatting |
| Evaluation runner | Dataset/run setup and individual sample/final-run writes are short operations | Each primary, candidate and judge PipelineService call |
| Prompt registry | Per-key version allocation, insert and old-version pruning are atomic; archive shares that key lock | No model calls occur in these operations |
| Agent profiles | Fresh locked profile mutation and transaction-scoped linked-key summary | Detached listing retrieves linked-key summaries after releasing its profile read boundary |
| Shadow traffic | Result insert; separate best-effort bounded retention transaction | Shadow provider request |
| Compatibility results | Per-natural-key read/create/update; scoped matrix reads | Secret resolution and capability probe/request |
| Dashboard log retention | Selection and deletion of at most 500 rows in one transaction | Yield between batches; no pricing evidence deletion |

### Batch metadata

Provider updates and local cancellation reload and lock the stored job rather
than saving an old object fetched before a network request. Provider-independent
identity fields and newer output metadata are not overwritten from that old copy.
Accessible-job lookup includes workspace, key and namespace constraints before
selecting a matching local/provider ID, preserving the existing legacy-null
allowance without selecting a different tenant's row first.

Sparse provider metadata does not supply an invented `validating` status. That
default remains appropriate only when creating a new legacy job. An empty HTTP
204 cancellation response is handled explicitly: the JSON adapter's empty object
must not turn a successful cancellation into a new validating job. These are
legacy job-control metadata semantics, not proof that a supplier charged zero or
that a pending media generation's budget can be released.

Legacy batch call logs still use their old accounting contract. This checkpoint
does not turn them into complete physical batch receipts or an authenticated
supplier invoice. Full priced-group/task recovery remains separate work.

### Evaluation and network calls

Imported sample failure rolls back the dataset/run/sample import together.
Executed experiments retain their existing incremental progress semantics: model
calls are not enclosed in a database transaction, and successful earlier calls
are not rolled back or blindly repeated when a later metadata write fails.
Target, candidate and judge mocks explicitly acquire the same database queue in
tests; real isolated HTTP tests also exercise their normal priced pipeline.

### Prompt and profile decisions

Prompt version allocation locks the workspace/key, including its initially absent
row. Pruning commits with the new version; failed deletion preserves the previous
version set. Archive obtains the same key lock and rereads its row before writing,
so it cannot recreate a version concurrently pruned by a publisher. Existing
content-storage opt-in and metadata-only responses remain unchanged.

Profile mutations lock the fresh row on PostgreSQL. Rendering a config cannot
save an old profile over a concurrent rename or disable. A linked-key summary
uses an explicit active manager from the same database; inactive or foreign
managers fail validation instead of silently joining an unrelated transaction.
This does not make profile metadata and key administration one new referential
integrity policy, nor change existing missing-key/drift behavior.

The profile generated-at column uses TypeORM's portable `Date` mapping: SQLite
continues to use a datetime column and PostgreSQL can initialize the entity using
a timestamp column. The former literal SQLite-only `datetime` type is not passed
to PostgreSQL. No live schema operation or pricing migration is performed.

### Compatibility and retention limitations

Single-node compatibility responses now apply workspace filtering, just like the
multi-node view. The existing compatibility entity has a global node/capability
unique index. Its writer lock matches that actual index; a conflicting foreign
workspace record is neither read into the response nor overwritten. This does
not silently migrate that legacy index into a new multi-tenant key scheme.

Shadow retention remains best effort: a cleanup failure does not roll back its
already committed result or repeat the provider request. Dashboard retention
keeps the existing configured policy and global maintenance scope, yields between
500-row batches and does not delete pricing snapshots, receipts, reservations or
adjustments. Full pricing retention/index/performance acceptance is still required.

## Verification

The cross-database contract covers 15 writer paths racing an actual cost-ledger
settlement that fails after its budget-effect insertion. Auxiliary changes survive
independently; the original hold/effect and exact balance remain intact; replay
then applies the settlement exactly once. Other cases cover atomic evaluation
failure, network work reentering the queue, per-key version concurrency, pruning
rollback, sparse/stale batch updates, principal-scoped lookup, compatibility
isolation, concurrent render/edit, transaction-manager validation, failed shadow
retention, bounded 503-row cleanup and uncommitted reader isolation.

Five new HTTP cases exercise concurrent real priced traffic/configuration,
primary/candidate/judge requests, required prompt-retention rollback, actual empty
204 cancellation and compatibility response privacy. Providers use synthetic
fixtures or mocks; no requests go through live 2099. Final source identity,
full-suite counts and owned-process cleanup are recorded in
[progress](pricing-engine-progress.md), not inferred from a focused pass.

Historical diagnostic failures are retained privately, including invalid initial
fixture casts, an incorrect zero-effects expectation that omitted the already
committed reservation, and the actual 204/sparse-status bug. The corrected tests
check preservation of the original reservation rather than weakening rollback
assertions. No migration 001–009 checksum or dependency version is changed.
