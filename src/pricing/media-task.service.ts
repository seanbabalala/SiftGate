import { mediaProcessingHash, verifyMediaObservation, mediaTaskContext } from "./media-observation-evidence";
import { videoResultProfile, translateNativeVideoResult, nativeVideoTaskContext, videoProfileStatusPath } from "./video-result-profile";
import { mediaEventDispositionBasis, applyMediaEventDisposition } from "./media-event-disposition-storage";
import { readMediaDispositionRecord } from "./media-event-disposition-record";
import type { MediaEventDispositionInput, MediaEventDispositionPreview } from "./media-event-disposition.types";
import { assertMediaAdministrator } from "./media-operator-access";
import {
  applyMediaLookup,
  mediaLookupBasis,
  preserveLookupTimeEvidence,
  readMediaLookupRecord,
} from "./media-job-lookup-storage";
import type {
  MediaLookupInput,
  MediaLookupPreview,
  MediaLookupObservation,
} from "./media-job-lookup.types";
import type { PricingActor } from "./pricing-repository.types";
import {
  readMediaEventHead,
  receiveOrderedMediaEvent,
  retainUnversionedMediaObservation,
} from "./media-supplier-storage";
import { supplierEventMetering } from "./media-supplier-event";
import type {
  MediaSupplierEvent,
  MediaSupplierSource,
} from "./media-supplier.types";
import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash, randomUUID } from "node:crypto";
import type { CanonicalMediaRequest } from "../canonical/canonical.types";
import { ConfigService } from "../config/config.service";
import type { NodeConfig } from "../config/gateway.config";
import { SecretReferenceResolverService } from "../config/secret-reference-resolver.service";
import type { GatewayApiKeyContext } from "../auth/gateway-api-key.service";
import { normalizeWorkspaceId } from "../workspaces/workspace-scope";
import { serializeDatabaseAccess } from "../database/database-serialization";
import {
  fetchMediaControl,
  mediaControlHeaders,
  readMediaControlMetadata,
} from "./media-control-client";
import { PricingRepository } from "./pricing-repository";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingRepositoryError } from "./pricing-repository.types";
import { pricingContentHash } from "./pricing-json";
import { calculateCost } from "./cost-calculator";
import { compilePriceBook } from "./pricing-compiler";
import { ExactDecimal } from "./exact-decimal";
import { loadCostAdjustments } from "./cost-adjustments";
import {
  mediaJobId,
  mediaJobStatus,
  meterMediaTask,
} from "./media-task-metering";
import type {
  MediaTaskContext,
  MediaTaskRow,
  MediaTaskObservationRow,
} from "./media-task.types";
import type {
  CostComputation,
  NormalizedUsage,
  PricingContext,
} from "./pricing.types";
import type { CostAttemptRow } from "./cost-ledger.types";

@Injectable()
export class MediaTaskService implements OnModuleDestroy {
  private readonly logger = new Logger(MediaTaskService.name);
  private readonly processing = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly controls = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(
    private readonly source: DataSource,
    private readonly prices: PricingRepository,
    private readonly ledger: CostLedgerService,
    private readonly config: ConfigService,
    @Optional() private readonly secrets?: SecretReferenceResolverService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.processing.values(), ...this.controls]);
  }

  descriptor(
    id: string,
    request: string,
    reservation: string,
    context: MediaTaskContext,
    clientKeyHash: string | null = null,
  ): MediaTaskRow {
    const node = this.config.getNode(context.target.node_id ?? "");
    if (!node) this.fail("Media task node is unavailable");
    const now = new Date().toISOString();
    const profile = context.operation === "video_generation" ? videoResultProfile(node.video_result_profile) : "generic-v1";
    if (profile !== "generic-v1") context = { ...context, video_result_profile: profile };
    return {
      id,
      client_key_hash: clientKeyHash,
      request_id: request,
      reservation_id: reservation,
      workspace_id: context.identity.workspaceId,
      node_id: node.id,
      model: context.target.model,
      operation: context.operation,
      api_key_id: context.identity.apiKeyId,
      api_key_name: context.identity.apiKeyName,
      namespace_id: context.identity.namespaceId,
      provider_job_id: null,
      credential_id: null,
      connection_hash: this.connectionHash(node),
      state: "reserved",
      provider_status: null,
      context_json: JSON.stringify(context),
      context_hash: pricingContentHash(context),
      revision: 0,
      accepted_at: null,
      terminal_at: null,
      last_error: null,
      poll_owner: null,
      poll_until: null,
      next_poll_at: now,
      created_at: now,
      updated_at: now,
    };
  }

  private submissionIdentity(
    canonical: CanonicalMediaRequest,
    workspace: string,
  ): { id: string; fingerprint: string } | null {
    const header = Object.entries(canonical.metadata.raw_headers).find(
      ([name]) => name.toLowerCase() === "idempotency-key",
    )?.[1];
    if (!header) return null;
    if (header.length > 256)
      this.fail("Idempotency key exceeds the supported length", 400);
    const id = pricingContentHash([
      workspace,
      canonical.metadata.api_key_id ?? canonical.metadata.api_key_name,
      canonical.metadata.namespace_id ?? null,
      canonical.source_format,
      header,
    ]);
    const fingerprint = pricingContentHash({
      model: canonical.model,
      format: canonical.source_format,
      content_type: canonical.content_type,
      payload: Buffer.isBuffer(canonical.payload)
        ? createHash("sha256").update(canonical.payload).digest("hex")
        : canonical.payload,
    });
    return { id, fingerprint };
  }

  /** A prior submission remains idempotent even if its price binding or node is later disabled. */
  async lookupClaim(
    canonical: CanonicalMediaRequest,
    workspace: string,
  ): Promise<{
    id: string;
    owner: false;
    request_id: string;
    task_id: string | null;
  } | null> {
    const identity = this.submissionIdentity(canonical, workspace);
    if (!identity || !(await this.ledger.available())) return null;
    const row = await this.read(() =>
      this.source.manager
        .createQueryBuilder()
        .select("c.*")
        .from("pricing_media_submissions", "c")
        .where("c.id = :id AND c.workspace_id = :workspace", {
          id: identity.id,
          workspace,
        })
        .getRawOne<{
          request_id: string;
          task_id: string | null;
          fingerprint_hash: string;
          state: string;
          lease_until: string;
        }>(),
    );
    if (!row) return null;
    if (row.fingerprint_hash !== identity.fingerprint)
      this.fail("Idempotency key was reused with a different request");
    if (
      !row.task_id &&
      (row.state === "not_dispatched" ||
        Date.parse(row.lease_until) < Date.now())
    )
      return null;
    return {
      id: identity.id,
      owner: false,
      request_id: row.request_id,
      task_id: row.task_id,
    };
  }

  async claim(
    canonical: CanonicalMediaRequest,
    requestId: string,
    workspace: string,
  ): Promise<{
    id: string;
    owner: boolean;
    request_id: string;
    task_id: string | null;
  } | null> {
    const identity = this.submissionIdentity(canonical, workspace);
    if (!identity) return null;
    const { id, fingerprint } = identity;
    return this.read(() =>
      this.source.transaction(async (manager) => {
        const now = new Date().toISOString();
        await manager
          .createQueryBuilder()
          .insert()
          .into("pricing_media_submissions")
          .values({
            id,
            workspace_id: workspace,
            request_id: requestId,
            fingerprint_hash: fingerprint,
            state: "starting",
            task_id: null,
            lease_until: new Date(Date.now() + 15 * 60000).toISOString(),
            created_at: now,
          })
          .orIgnore()
          .execute();
        const query = manager
          .createQueryBuilder()
          .select("c.*")
          .from("pricing_media_submissions", "c")
          .where("c.id = :id AND c.workspace_id = :workspace", {
            id,
            workspace,
          });
        if (this.source.options.type === "postgres")
          query.setLock("pessimistic_write");
        const row = await query.getRawOne<{
          request_id: string;
          fingerprint_hash: string;
          state: string;
          task_id: string | null;
          lease_until: string;
        }>();
        if (!row || row.fingerprint_hash !== fingerprint)
          this.fail("Idempotency key was reused with a different request");
        if (row.request_id === requestId)
          return {
            id,
            owner: true,
            request_id: requestId,
            task_id: row.task_id,
          };
        if (
          !row.task_id &&
          (row.state === "not_dispatched" ||
            Date.parse(row.lease_until) < Date.now())
        ) {
          await manager
            .createQueryBuilder()
            .update("pricing_media_submissions")
            .set({
              request_id: requestId,
              state: "starting",
              lease_until: new Date(Date.now() + 15 * 60000).toISOString(),
            })
            .where("id = :id AND workspace_id = :workspace", { id, workspace })
            .execute();
          return { id, owner: true, request_id: requestId, task_id: null };
        }
        return {
          id,
          owner: false,
          request_id: row.request_id,
          task_id: row.task_id,
        };
      }),
    );
  }

  async closeClaim(
    id: string,
    workspace: string,
    request: string,
  ): Promise<void> {
    await this.read(() =>
      this.source.manager
        .createQueryBuilder()
        .update("pricing_media_submissions")
        .set({ state: "not_dispatched" })
        .where(
          "id = :id AND workspace_id = :workspace AND request_id = :request AND task_id IS NULL",
          { id, workspace, request },
        )
        .execute(),
    );
  }

  async markSubmitted(id: string, workspace: string): Promise<void> {
    await this.write(id, workspace, async (manager, task) => {
      if (task.state !== "reserved")
        this.fail("Media task dispatch is already fenced");
      await this.patch(manager, task, { state: "submitted" });
    });
  }
  async markSynchronous(id: string, workspace: string): Promise<void> {
    await this.write(id, workspace, async (manager, task) => {
      if (task.terminal_at || (await readMediaEventHead(manager, task))) return;
      await this.patch(manager, task, { state: "synchronous" });
    });
  }
  async markUncertain(id: string, workspace: string): Promise<void> {
    await this.write(id, workspace, (manager, task) =>
      ["reserved", "submitted"].includes(task.state) && !task.provider_job_id
        ? this.patch(manager, task, {
            state: "uncertain",
            last_error: "media_submission_outcome_unknown",
          })
        : Promise.resolve(),
    );
  }

  async accept(
    id: string,
    workspace: string,
    body: Record<string, unknown>,
    credentialId?: string,
  ): Promise<void> {
    await this.observe(id, workspace, body, credentialId ?? "default");
    await this.process(id, workspace);
  }

  async observe(
    id: string,
    workspace: string,
    body: Record<string, unknown>,
    credentialId?: string,
    fence?: { owner: string; revision: number },
  ): Promise<void> {
    await this.write(id, workspace, async (manager, task) => {
      if (
        fence &&
        (task.poll_owner !== fence.owner ||
          task.revision !== fence.revision ||
          !task.poll_until ||
          Date.parse(task.poll_until) <= Date.now())
      )
        return;
      const context = this.context(task);
      const profile = videoResultProfile(context.video_result_profile);
      if (profile !== "generic-v1" && Object.keys(body).length === 0) return;
      const native = profile !== "generic-v1" ? translateNativeVideoResult(profile, body) : null;
      const status = native?.status ?? mediaJobStatus(body);
      const providerId = native?.provider_job_id ?? mediaJobId(body) ?? task.provider_job_id;
      if (task.provider_job_id && providerId !== task.provider_job_id)
        this.fail("Provider job identity changed");
      if (
        task.credential_id &&
        credentialId &&
        task.credential_id !== credentialId
      )
        this.fail("Provider credential identity changed");
      if (task.terminal_at && status === "pending") return;
      const now = new Date().toISOString();
      const terminalAt =
        task.terminal_at ?? (status === "pending" ? null : now);
      const acceptedAt = task.accepted_at ?? now;
      const metered = meterMediaTask(context, body, status);
      const pricingContext = native ? nativeVideoTaskContext(metered.context) : await preserveLookupTimeEvidence(manager, task, {
        ...metered.context,
        time_estimated: true,
        provider_accepted_at: acceptedAt,
        ...(terminalAt ? { completed_at: terminalAt } : {}),
      });
      if (
        await retainUnversionedMediaObservation(manager, task, {
          task_id: id,
          status,
          usage: metered.usage,
          context: pricingContext,
          provider_job_id: providerId,
        })
      )
        return;
      await this.storeObservation(
        manager,
        task,
        status,
        metered.usage,
        pricingContext,
        providerId,
        credentialId,
        acceptedAt,
        terminalAt,
        this.safeError(body),
      );
    });
  }

  private async storeObservation(
    manager: EntityManager,
    task: MediaTaskRow,
    status: MediaTaskObservationRow["status"],
    usage: NormalizedUsage,
    pricingContext: PricingContext,
    providerId: string | null,
    credentialId: string | undefined,
    acceptedAt: string,
    terminalAt: string | null,
    errorCode: string | null,
    forceRevision = false,
  ): Promise<string> {
    const id = task.id,
      workspace = task.workspace_id,
      now = new Date().toISOString();
    const hash = pricingContentHash({
      status,
      usage,
      context: pricingContext,
    });
    const duplicate = await manager
      .createQueryBuilder()
      .select("o.*")
      .from("pricing_media_observations", "o")
      .where("o.task_id = :task AND o.workspace_id = :workspace", {
        task: id,
        workspace,
      })
      .orderBy("o.revision", "DESC")
      .getRawOne<MediaTaskObservationRow>();
    if (!forceRevision && duplicate?.observation_hash === hash) {
      await this.patch(manager, task, {
        provider_job_id: providerId,
        credential_id: credentialId ?? task.credential_id,
      });
      if (providerId)
        await manager
          .createQueryBuilder()
          .update("pricing_reservations")
          .set({ job_id: providerId })
          .where("id = :id AND workspace_id = :workspace", {
            id: task.reservation_id,
            workspace,
          })
          .execute();
      if (status === "pending" && providerId)
        await this.patch(manager, task, {
          state: "pending",
          next_poll_at: new Date(Date.now() + 30000).toISOString(),
        });
      return duplicate.id;
    }
    const revision = task.revision + 1;
    const observation: MediaTaskObservationRow = {
      id: randomUUID(),
      task_id: id,
      request_id: task.request_id,
      workspace_id: workspace,
      revision,
      observation_hash: hash,
      status,
      usage_json: JSON.stringify(usage),
      context_json: JSON.stringify(pricingContext),
      observed_at: now,
      action: null,
      expected_hash: null,
      cost_json: null,
      processing_hash: null,
      processed: status === "pending" ? 1 : 0,
    };
    await manager
      .createQueryBuilder()
      .insert()
      .into("pricing_media_observations")
      .values(observation)
      .execute();
    await this.patch(manager, task, {
      provider_job_id: providerId,
      credential_id: credentialId ?? task.credential_id,
      revision,
      accepted_at: acceptedAt,
      terminal_at: terminalAt,
      state:
        status === "pending"
          ? providerId
            ? "pending"
            : "uncertain"
          : "terminal",
      provider_status: status,
      last_error: errorCode,
      next_poll_at: new Date(Date.now() + 30000).toISOString(),
    });
    await manager
      .createQueryBuilder()
      .update("pricing_reservations")
      .set({ job_id: providerId ?? `task:${id}` })
      .where("id = :id AND workspace_id = :workspace", {
        id: task.reservation_id,
        workspace,
      })
      .execute();
    return observation.id;
  }

  /** Called only after a registered connector has authenticated a complete snapshot. */
  async receiveSupplierEvent(
    source: MediaSupplierSource,
    event: MediaSupplierEvent,
  ) {
    return this.write(
      event.task_id,
      source.workspace_id,
      async (manager, task) => {
        const context = this.context(task),
          metered = supplierEventMetering(context, event);
        return receiveOrderedMediaEvent(
          manager,
          task,
          source,
          event,
          async () =>
            this.storeObservation(
              manager,
              task,
              event.status,
              metered.usage,
              metered.context,
              event.provider_job_id,
              source.credential_id,
              event.accepted_at,
              event.completed_at,
              event.status === "failed" ? "provider_media_job_error" : null,
            ),
        );
      },
    );
  }

  async lookupBasis(id: string, workspace: string, actor?: PricingActor) {
    if (!(await this.ledger.available()))
      this.fail("Media lookup requires the explicit pricing migration", 503);
    return this.write(
      id,
      workspace,
      (manager, task) => mediaLookupBasis(manager, task, this.context(task)),
      actor ? (manager) => assertMediaAdministrator(manager, actor) : undefined,
    );
  }
  /** Read-only status GET using the original physical credential and pinned connection. No task/lease writes. */
  probeProviderJob(
    task: MediaTaskRow,
    credential: string,
    jobId: string,
  ): Promise<MediaLookupObservation> {
    return this.track(async () => {
      const context = this.context(task),
        body = await readMediaControlMetadata(
          await this.fetchTask(
            { ...task, provider_job_id: jobId, credential_id: credential },
            "status",
          ),
        );
      const profile = videoResultProfile(context.video_result_profile);
      const native = profile !== "generic-v1" ? translateNativeVideoResult(profile, body) : null;
      if ((native?.provider_job_id ?? mediaJobId(body)) !== jobId)
        this.fail(
          "Provider status response does not identify the proposed job",
        );
      const reported = String(
        body.status ?? body.state ?? body.phase ?? "",
      ).toLowerCase();
      if (
        !native && ![
          "pending",
          "queued",
          "running",
          "processing",
          "in_progress",
          "submitted",
          "completed",
          "succeeded",
          "success",
          "done",
          "partially_completed",
          "failed",
          "error",
          "rejected",
          "cancelled",
          "canceled",
        ].includes(reported) &&
        typeof body.done !== "boolean"
      )
        this.fail("Provider status response has no supported task state");
      const status = native?.status ?? mediaJobStatus(body),
        metered = meterMediaTask(context, body, status);
      // No provider time is inferred from a recovery GET's wall clock. Missing
      // acceptance/completion instants must remain missing for time-based rates.
      const pricing: PricingContext = {
        ...metered.context,
        time_estimated: true,
      };
      delete pricing.provider_accepted_at;
      delete pricing.completed_at;
      if (!native && task.accepted_at) pricing.provider_accepted_at = task.accepted_at;
      if (!native && task.terminal_at) pricing.completed_at = task.terminal_at;
      return {
        provider_job_id: jobId,
        credential_id: credential,
        status,
        usage: metered.usage,
        context: pricing,
        error_code: this.safeError(body),
      };
    });
  }
  async recordedLookup(
    actor: PricingActor,
    id: string,
    operationId: string,
    input?: MediaLookupInput,
  ) {
    if (!(await this.ledger.available()))
      this.fail("Media lookup requires the explicit pricing migration", 503);
    return this.write(
      id,
      actor.workspace_id,
      (manager) =>
        readMediaLookupRecord(manager, actor, id, operationId, input),
      (manager) => assertMediaAdministrator(manager, actor),
    );
  }
  async applyJobLookup(
    actor: PricingActor,
    id: string,
    input: MediaLookupInput,
    preview: MediaLookupPreview,
  ) {
    return this.write(
      id,
      actor.workspace_id,
      async (manager, task) => {
        const prior = await readMediaLookupRecord(
          manager,
          actor,
          id,
          input.id,
          input,
        );
        if (prior) return prior;
        const basis = await mediaLookupBasis(manager, task, this.context(task));
        const node = this.config.getNode(task.node_id);
        if (!node || this.connectionHash(node) !== task.connection_hash)
          this.fail("Original media connection changed before reconciliation");
        const observation = preview.observation;
        return applyMediaLookup(manager, actor, basis, input, preview, () =>
          this.storeObservation(
            manager,
            task,
            observation.status,
            observation.usage,
            observation.context,
            observation.provider_job_id,
            observation.credential_id,
            task.accepted_at ?? task.created_at,
            observation.status === "pending" ? null : new Date().toISOString(),
            observation.error_code,
          ),
        );
      },
      (manager) => assertMediaAdministrator(manager, actor),
    );
  }

  async eventDispositionBasis(actor: PricingActor, id: string, event: string) {
    if (!(await this.ledger.available())) this.fail("Media disposition requires the explicit pricing migration", 503);
    return this.write(id, actor.workspace_id,
      (manager, task) => mediaEventDispositionBasis(manager, task, this.context(task), event),
      actor.role === "admin" ? manager => assertMediaAdministrator(manager, actor) : undefined);
  }
  async recordedEventDisposition(actor: PricingActor, id: string, event: string, operationId: string, input?: MediaEventDispositionInput) {
    if (!(await this.ledger.available())) this.fail("Media disposition requires the explicit pricing migration", 503);
    return this.write(id, actor.workspace_id,
      async manager => (await readMediaDispositionRecord(manager, actor.workspace_id, id, event, { id: operationId, actor, input }))?.receipt ?? null,
      manager => assertMediaAdministrator(manager, actor));
  }
  async applyEventDisposition(actor: PricingActor, id: string, event: string, input: MediaEventDispositionInput, preview: MediaEventDispositionPreview) {
    return this.write(id, actor.workspace_id, async (manager, task) => {
      const prior = await readMediaDispositionRecord(manager, actor.workspace_id, id, event, { id: input.id, actor, input });
      if (prior) return prior.receipt;
      const basis = await mediaEventDispositionBasis(manager, task, this.context(task), event);
      return applyMediaEventDisposition(manager, actor, basis, input, preview, async () => {
        const observation = basis.observation;
        const observationId = await this.storeObservation(manager, task, observation.status, observation.usage, observation.context,
          observation.provider_job_id, observation.credential_id,
          observation.context.provider_accepted_at ?? task.accepted_at ?? task.created_at,
          observation.status === "pending" ? null : observation.context.completed_at ?? task.terminal_at ?? new Date().toISOString(), observation.error_code, true);
        if (observation.status !== "pending") {
          const stored = await manager.createQueryBuilder().select("o.*").from("pricing_media_observations", "o")
            .where("o.id = :id", { id: observationId }).getRawOne<MediaTaskObservationRow>();
          if (!stored || !preview.cost || !["initial", "adjustment", "noop"].includes(preview.impact.operation)) this.fail("Media disposition has no terminal computation");
          const prepared = { ...stored, action: preview.impact.operation as MediaTaskObservationRow["action"],
            expected_hash: preview.previous_cost_hash, cost_json: JSON.stringify(preview.cost) };
          await manager.createQueryBuilder().update("pricing_media_observations").set({ action: prepared.action, expected_hash: prepared.expected_hash,
            cost_json: prepared.cost_json, processing_hash: this.processingHash(prepared) }).where("id = :id", { id: observationId }).execute();
        }
        return observationId;
      });
    }, async manager => {
      await assertMediaAdministrator(manager, actor);
      // Workspace-wide operation IDs must not race across distinct task locks.
      if (manager.connection.options.type === "postgres") await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
        ['siftgate.media-disposition', `${manager.connection.options.schema ?? ''}:${actor.workspace_id}:${input.id}`]);
    });
  }

  async hasPendingFinancialProcessing(id: string, workspace: string): Promise<boolean> {
    const task = await this.get(id, workspace);
    if (!task) this.fail("Media task is not present in this workspace", 404);
    return task.state === "terminal";
  }

  process(id: string, workspace: string): Promise<void> {
    const key = `${workspace}:${id}`;
    const running = this.processing.get(key);
    if (running) return running;
    const work = this.processPending(id, workspace).finally(() =>
      this.processing.delete(key),
    );
    this.processing.set(key, work);
    return work;
  }

  private async processPending(id: string, workspace: string): Promise<void> {
    for (let limit = 0; limit < 50; limit++) {
      const task = await this.get(id, workspace);
      if (!task) return;
      const observation = await this.read(() =>
        this.source.manager
          .createQueryBuilder()
          .select("o.*")
          .from("pricing_media_observations", "o")
          .where(
            "o.task_id = :id AND o.workspace_id = :workspace AND o.processed = 0",
            { id, workspace },
          )
          .orderBy("o.revision", "ASC")
          .getRawOne<MediaTaskObservationRow>(),
      );
      if (!observation) {
        if (task.state !== "synchronous") await this.ledger.processActualMediaObservation(id, workspace);
        return;
      }
      this.verifyObservation(task, observation);
      const context = this.context(task);
      let cost: CostComputation;
      if (observation.cost_json)
        cost = JSON.parse(observation.cost_json) as CostComputation;
      else {
        const snapshot = await this.prices.restoreRequest(
          task.request_id,
          workspace,
        );
        const usage = JSON.parse(observation.usage_json) as NormalizedUsage;
        const pricingContext = JSON.parse(
          observation.context_json,
        ) as PricingContext;
        const quote = snapshot.quote(context.target, usage, pricingContext);
        cost =
          quote.binding_id || !context.legacy_price
            ? quote.cost
            : calculateCost(
                usage,
                compilePriceBook(context.legacy_price, {
                  book_id: "legacy-config",
                  version_id: `legacy-${context.legacy_version}`,
                }).resolve(usage, pricingContext),
                { report_currency: "USD" },
              );
      }
      const prepared = await this.write(
        id,
        workspace,
        async (manager, locked) => {
          const row = await manager
            .createQueryBuilder()
            .select("o.*")
            .from("pricing_media_observations", "o")
            .where("o.id = :id AND o.workspace_id = :workspace", {
              id: observation.id,
              workspace,
            })
            .getRawOne<MediaTaskObservationRow>();
          if (!row || row.processed) return null;
          this.verifyObservation(locked, row);
          if (row.cost_json && row.action) return row;
          const attempt = await manager
            .createQueryBuilder()
            .select("a.*")
            .from("pricing_attempts", "a")
            .where("a.id = :id AND a.workspace_id = :workspace", {
              id,
              workspace,
            })
            .getRawOne<CostAttemptRow>();
          if (!attempt) this.fail("Media task attempt is unavailable");
          const changes = await loadCostAdjustments(
            manager,
            locked.request_id,
            workspace,
            [attempt],
          );
          const currentHash =
            changes.get(id)?.at(-1)?.cost_hash ?? attempt.cost_hash;
          const action =
            attempt.state !== "terminal"
              ? "initial"
              : currentHash === pricingContentHash(cost)
                ? "noop"
                : "adjustment";
          const payload = {
            ...row,
            action,
            expected_hash: currentHash,
            cost_json: JSON.stringify(cost),
          } as const;
          const patch = {
            action,
            expected_hash: currentHash,
            cost_json: payload.cost_json,
            processing_hash: this.processingHash(payload),
          } as const;
          await manager
            .createQueryBuilder()
            .update("pricing_media_observations")
            .set(patch)
            .where("id = :id AND workspace_id = :workspace", {
              id: row.id,
              workspace,
            })
            .execute();
          return { ...row, ...patch };
        },
      );
      if (!prepared) continue;
      this.verifyObservation(task, prepared);
      cost = JSON.parse(prepared.cost_json!) as CostComputation;
      const actual = await this.ledger.processActualMediaObservation(id, workspace, prepared.id);
      if (actual === "deferred") return;
      if (actual) continue;
      if (prepared.action === "initial") {
        const totalInput = cost.usage.quantities.total_input_tokens?.value;
        const output = cost.usage.quantities.output_tokens?.value;
        const tokens =
          totalInput != null && output != null
            ? ExactDecimal.parse(totalInput)
                .add(ExactDecimal.parse(output))
                .toFixed(0)
            : context.logical_tokens;
        await this.ledger.settle(
          task.reservation_id,
          workspace,
          "commit",
          tokens,
          cost.report_amount ?? context.fallback_cost_usd,
          cost.report_amount === null
            ? "media_job_reserved_estimate"
            : "legacy_logical_job",
          {
            attemptId: id,
            cost,
            errorCode:
              prepared.status === "completed"
                ? null
                : `media_job_${prepared.status}`,
          },
        );
      } else if (prepared.action === "adjustment") {
        const disposition = await this.read(async () => {
          const link = await this.source.manager.createQueryBuilder().select("d.event_record_id", "event_record_id").from("pricing_media_event_dispositions", "d")
            .where("d.observation_id = :id AND d.task_id = :task AND d.workspace_id = :workspace", { id: prepared.id, task: id, workspace })
            .getRawOne<{ event_record_id: string }>();
          return link ? readMediaDispositionRecord(this.source.manager, workspace, id, link.event_record_id) : null;
        });
        await this.ledger.adjustAttempt({
          id: `media:${prepared.id}`,
          attemptId: id,
          workspace,
          expectedCostHash: prepared.expected_hash!,
          cost,
          reason: disposition ? (JSON.parse(disposition.row.document_json) as { input: MediaEventDispositionInput }).input.reason : "Provider task usage observation",
          actorId: disposition?.row.actor_id ?? "system:media-task",
          source: disposition ? "reconciliation" : "provider_job_result",
        });
      }
      await this.write(id, workspace, async (manager, locked) => {
        await manager
          .createQueryBuilder()
          .update("pricing_media_observations")
          .set({ processed: 1 })
          .where("id = :id AND workspace_id = :workspace", {
            id: prepared.id,
            workspace,
          })
          .execute();
        const remaining = await manager
          .createQueryBuilder()
          .select("o.id")
          .from("pricing_media_observations", "o")
          .where(
            "o.task_id = :id AND o.workspace_id = :workspace AND o.processed = 0",
            { id, workspace },
          )
          .getRawOne();
        await this.patch(manager, locked, {
          state: remaining ? "terminal" : "settled",
        });
      });
    }
  }

  async get(id: string, workspace: string): Promise<MediaTaskRow | null> {
    if (!(await this.ledger.available())) return null;
    return this.read(
      async () =>
        (await this.source.manager
          .createQueryBuilder()
          .select("t.*")
          .from("pricing_media_tasks", "t")
          .where("t.id = :id AND t.workspace_id = :workspace", {
            id,
            workspace,
          })
          .getRawOne<MediaTaskRow>()) ?? null,
    );
  }

  async findOwned(
    id: string,
    key: GatewayApiKeyContext | undefined,
    kind: "video" | "image" = "video",
  ): Promise<MediaTaskRow | null> {
    if (!key || !(await this.ledger.available())) return null;
    const workspace = normalizeWorkspaceId(key.workspace_id);
    const tasks = await this.read(() =>
      this.source.manager
        .createQueryBuilder()
        .select("t.*")
        .from("pricing_media_tasks", "t")
        .where(
          "(t.id = :id OR t.request_id = :id OR t.provider_job_id = :id) AND t.workspace_id = :workspace AND t.state <> :sync",
          { id, workspace, sync: "synchronous" },
        )
        .andWhere(
          key.id
            ? "t.api_key_id = :key"
            : "t.api_key_id IS NULL AND t.api_key_name = :name",
          { key: key.id, name: key.name },
        )
        .getRawMany<MediaTaskRow>(),
    );
    const owned = tasks.filter(
      (task) =>
        (kind === "video"
          ? task.operation === "video_generation"
          : task.operation.startsWith("image_")) &&
        task.namespace_id === (key.namespace_id ?? null),
    );
    if (owned.length > 1)
      this.fail("Ambiguous provider job ID; use the gateway request ID");
    return owned[0] ?? null;
  }

  refresh(task: MediaTaskRow): Promise<void> {
    return this.track(() => this.refreshTask(task));
  }

  private async refreshTask(task: MediaTaskRow): Promise<void> {
    if (
      !task.provider_job_id ||
      task.state === "uncertain" ||
      task.state === "synchronous"
    )
      return;
    const lease = await this.acquireControl(task);
    if (!lease) return;
    try {
      const body = await readMediaControlMetadata(
        await this.fetchTask(lease.task, "status"),
      );
      await this.observe(task.id, task.workspace_id, body, undefined, lease);
    } finally {
      await this.releaseControl(task, lease.owner);
    }
    await this.process(task.id, task.workspace_id);
  }
  cancel(task: MediaTaskRow): Promise<void> {
    return this.track(() => this.cancelTask(task));
  }

  private async cancelTask(task: MediaTaskRow): Promise<void> {
    const lease = await this.acquireControl(task);
    if (!lease) this.fail("Media task control request is already in progress");
    try {
      const body = await readMediaControlMetadata(
        await this.fetchTask(lease.task, "cancel"),
      );
      await this.observe(task.id, task.workspace_id, body, undefined, lease);
    } finally {
      await this.releaseControl(task, lease.owner);
    }
    await this.process(task.id, task.workspace_id);
  }
  async content(task: MediaTaskRow): Promise<globalThis.Response> {
    return this.fetchTask(task, "content");
  }

  private async acquireControl(
    task: MediaTaskRow,
  ): Promise<{ owner: string; revision: number; task: MediaTaskRow } | null> {
    if (this.stopped) this.fail("Media task service is stopping", 503);
    return this.write(task.id, task.workspace_id, async (manager, current) => {
      if (
        current.poll_owner &&
        current.poll_until &&
        Date.parse(current.poll_until) > Date.now()
      )
        return null;
      const owner = randomUUID();
      await this.patch(manager, current, {
        poll_owner: owner,
        poll_until: new Date(Date.now() + 15000).toISOString(),
      });
      return { owner, revision: current.revision, task: current };
    });
  }
  private async releaseControl(
    task: MediaTaskRow,
    owner: string,
  ): Promise<void> {
    await this.write(task.id, task.workspace_id, async (manager, current) => {
      if (current.poll_owner === owner)
        await this.patch(manager, current, {
          poll_owner: null,
          poll_until: null,
          next_poll_at: new Date(Date.now() + 30000).toISOString(),
        });
    });
  }

  recover(): Promise<void> {
    return this.track(() => this.recoverTasks());
  }

  private async recoverTasks(): Promise<void> {
    if (this.stopped || !(await this.ledger.available())) return;
    // A process dying around generation dispatch cannot prove that the job was not accepted.
    // Preserve its hold for reconciliation; never dispatch the generation again.
    const stale = await this.read(() =>
      this.source.manager
        .createQueryBuilder()
        .select("t.*")
        .from("pricing_media_tasks", "t")
        .where("t.state IN (:...states) AND t.updated_at < :before", {
          states: ["reserved", "submitted"],
          before: new Date(Date.now() - 15 * 60000).toISOString(),
        })
        .limit(10)
        .getRawMany<MediaTaskRow>(),
    );
    for (const task of stale)
      await this.write(task.id, task.workspace_id, async (manager, current) => {
        if (
          ["reserved", "submitted"].includes(current.state) &&
          Date.parse(current.updated_at) < Date.now() - 15 * 60000
        )
          await this.patch(manager, current, {
            state: "uncertain",
            last_error: "media_submission_outcome_unknown",
          });
      });
    const tasks = await this.read(() =>
      this.source.manager
        .createQueryBuilder()
        .select("t.*")
        .from("pricing_media_tasks", "t")
        .where("t.state IN (:...states) AND t.next_poll_at <= :now", {
          states: ["pending", "terminal"],
          now: new Date().toISOString(),
        })
        .orderBy("t.next_poll_at", "ASC")
        .limit(10)
        .getRawMany<MediaTaskRow>(),
    );
    for (const task of tasks) {
      if (this.stopped) break;
      try {
        if (task.state === "terminal")
          await this.process(task.id, task.workspace_id);
        else await this.refresh(task);
      } catch {
        this.logger.warn(
          "Media task remains pending; no generation was redispatched.",
        );
        await this.write(task.id, task.workspace_id, (manager, row) =>
          this.patch(manager, row, {
            last_error: "media_task_recovery_pending",
            next_poll_at: new Date(Date.now() + 30000).toISOString(),
          }),
        );
      }
    }
  }

  async publicView(task: MediaTaskRow): Promise<Record<string, unknown>> {
    const summary = await this.ledger.summary(
      task.request_id,
      task.workspace_id,
    );
    return {
      id: task.provider_job_id ?? task.request_id,
      request_id: task.request_id,
      object:
        task.operation === "video_generation"
          ? "video.generation.job"
          : "image.generation.job",
      model: task.model,
      status:
        task.state === "synchronous"
          ? summary?.status === "pending"
            ? "pending"
            : "completed"
          : (task.provider_status ??
            (task.state === "uncertain" ? "unknown" : "queued")),
      pricing_status: task.state,
      output_retained: false,
      ...(task.state === "synchronous"
        ? { output_unavailable_reason: "synchronous_output_not_retained" }
        : {}),
      created_at: task.created_at,
      updated_at: task.updated_at,
      error: task.last_error,
      cost: summary
        ? {
            status: summary.status,
            currency: summary.report_currency,
            amount: summary.amount,
            known_subtotal: summary.known_subtotal,
          }
        : null,
    };
  }

  private async fetchTask(
    task: MediaTaskRow,
    action: "status" | "cancel" | "content",
  ): Promise<globalThis.Response> {
    if (this.stopped) this.fail("Media task service is stopping", 503);
    const context = this.context(task);
    const profile = videoResultProfile(context.video_result_profile);
    if (profile !== "generic-v1" && action !== "status")
      this.fail("Selected native video profile supports status metadata only; content and cancellation require a separately verified connector", 400);
    const node = this.config.getNode(task.node_id);
    if (!node || this.connectionHash(node) !== task.connection_hash)
      this.fail(
        "Media task node configuration changed; reconciliation is required",
      );
    if (!task.provider_job_id || !task.credential_id)
      this.fail("Media task provider identity is unresolved");
    const image = task.operation.startsWith("image_");
    const endpoint = image
      ? action === "status"
        ? node.images_status_endpoint
        : action === "cancel"
          ? node.images_cancel_endpoint
          : node.images_content_endpoint
      : action === "status"
        ? node.video_status_endpoint
        : action === "cancel"
          ? node.video_cancel_endpoint
          : node.video_content_endpoint;
    if (!endpoint || !/:id|\{id\}/.test(endpoint))
      this.fail("Media task control endpoint is not configured", 400);
    const headers = await mediaControlHeaders(
      node,
      task.credential_id,
      this.secrets,
    );
    if (this.stopped) this.fail("Media task service is stopping", 503);
    const currentNode = this.config.getNode(task.node_id);
    if (
      !currentNode ||
      this.connectionHash(currentNode) !== task.connection_hash
    )
      this.fail("Media connection changed while resolving credentials");
    const path = videoProfileStatusPath(profile, endpoint, task.provider_job_id);
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${node.base_url.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      this.fail("Unsupported media task endpoint", 400);
    return fetchMediaControl(
      url.toString(),
      { method: action === "cancel" ? "POST" : "GET", headers },
      this.controllers,
      action === "content" ? 60000 : 5000,
    );
  }

  private track<T>(action: () => Promise<T>): Promise<T> {
    const work = action().finally(() => this.controls.delete(work));
    this.controls.add(work);
    return work;
  }

  private processingHash(row: MediaTaskObservationRow): string { return mediaProcessingHash(row); }
  private verifyObservation(task: MediaTaskRow, row: MediaTaskObservationRow): void { verifyMediaObservation(task, row); }
  private context(task: MediaTaskRow): MediaTaskContext { return mediaTaskContext(task); }
  connectionHash(node: NodeConfig): string {
    return pricingContentHash({
      id: node.id,
      base_url: node.base_url,
      protocol: node.protocol,
      auth_type: node.auth_type,
      auth_header_name: node.auth_header_name,
      auth_header_prefix: node.auth_header_prefix,
      headers: node.headers,
      status: node.video_status_endpoint,
      cancel: node.video_cancel_endpoint,
      content: node.video_content_endpoint,
      image_status: node.images_status_endpoint,
      image_cancel: node.images_cancel_endpoint,
      image_content: node.images_content_endpoint,
    });
  }
  private safeError(body: Record<string, unknown>): string | null {
    return body.error ? "provider_media_job_error" : null;
  }
  private read<T>(action: () => Promise<T>): Promise<T> {
    return serializeDatabaseAccess(this.source, action);
  }
  private async write<T>(
    id: string,
    workspace: string,
    action: (manager: EntityManager, task: MediaTaskRow) => Promise<T>,
    authorize?: (manager: EntityManager) => Promise<void>,
  ): Promise<T> {
    return this.read(() =>
      this.source.transaction(async (manager) => {
        await authorize?.(manager);
        const initial = await manager
          .createQueryBuilder()
          .select("t.*")
          .from("pricing_media_tasks", "t")
          .where("t.id = :id AND t.workspace_id = :workspace", {
            id,
            workspace,
          })
          .getRawOne<MediaTaskRow>();
        if (!initial)
          this.fail("Media task is not present in this workspace", 404);
        const request = manager
          .createQueryBuilder()
          .select("s.request_id")
          .from("pricing_request_snapshots", "s")
          .where("s.request_id = :request AND s.workspace_id = :workspace", {
            request: initial.request_id,
            workspace,
          });
        if (this.source.options.type === "postgres")
          request.setLock("pessimistic_write");
        await request.getRawOne();
        const query = manager
          .createQueryBuilder()
          .select("t.*")
          .from("pricing_media_tasks", "t")
          .where("t.id = :id AND t.workspace_id = :workspace", {
            id,
            workspace,
          });
        if (this.source.options.type === "postgres")
          query.setLock("pessimistic_write");
        const task = await query.getRawOne<MediaTaskRow>();
        if (!task) this.fail("Media task is unavailable", 404);
        return action(manager, task);
      }),
    );
  }
  private async patch(
    manager: EntityManager,
    task: MediaTaskRow,
    values: Partial<MediaTaskRow>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update("pricing_media_tasks")
      .set({ ...values, updated_at: new Date().toISOString() })
      .where("id = :id AND workspace_id = :workspace", {
        id: task.id,
        workspace: task.workspace_id,
      })
      .execute();
  }
  private fail(message: string, status = 409): never {
    throw new PricingRepositoryError(
      "pricing_media_task_conflict",
      message,
      status,
    );
  }
}
