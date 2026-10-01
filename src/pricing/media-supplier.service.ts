import { readMediaDispositionRecord } from "./media-event-disposition-record";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import { ConfigService } from "../config/config.service";
import { serializeDatabaseAccess } from "../database/database-serialization";
import {
  assertMediaAdministrator,
  requireMediaOperator,
} from "./media-operator-access";
import {
  mediaCursor,
  nextMediaCursor,
  type MediaPageOptions,
  mediaTaskInventory,
  mediaTaskSummary,
  type MediaTaskView,
} from "./media-inventory";
import { MediaTaskService } from "./media-task.service";
import { CostLedgerService } from "./cost-ledger.service";
import { PricingApiInput } from "./pricing-api-input";
import {
  mediaSourceHash,
  readMediaSource,
  verifyMediaEventRecord,
  mediaEventReply,
} from "./media-supplier-storage";
import {
  authenticateMediaSupplierEvent,
  mediaSupplierError,
  parseMediaSupplierEvent,
} from "./media-supplier-event";
import { type PricingActor } from "./pricing-repository.types";
import type {
  MediaSupplierAuthentication,
  MediaSupplierEventRow,
  MediaSupplierSource,
} from "./media-supplier.types";

@Injectable()
export class MediaSupplierService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly tasks: MediaTaskService,
    private readonly ledger: CostLedgerService,
  ) {}
  private run<T>(action: () => Promise<T>): Promise<T> {
    return serializeDatabaseAccess(this.source, action);
  }
  private async available() {
    if (!(await this.ledger.available()))
      mediaSupplierError(
        "Media event storage requires the explicit pricing migration",
        503,
      );
  }
  async configure(actor: PricingActor, id: string, value: unknown) {
    await this.available();
    const reader = new PricingApiInput(value),
      raw = reader.body([
        "revision",
        "node_id",
        "credential_id",
        "secret_env",
        "enabled",
        "reason",
        "confirm",
      ]);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
      reader.invalid("id", "Use an opaque source identifier");
    const revision = reader.integer(raw.revision, "revision", 0, 1000000000),
      nodeId = reader.string(raw.node_id, "node_id"),
      credentialId = reader.string(raw.credential_id, "credential_id"),
      secretEnv = reader.string(raw.secret_env, "secret_env", 128),
      reason = reader.string(raw.reason, "reason", 1000);
    const enabled = reader.boolean(raw.enabled, "enabled");
    if (!/^SIFTGATE_MEDIA_EVENT_[A-Z0-9_]{1,96}$/.test(secretEnv))
      reader.invalid(
        "secret_env",
        "Only dedicated SIFTGATE_MEDIA_EVENT_ environment variables are allowed",
      );
    if (raw.confirm !== true || !reason.trim())
      reader.invalid(
        "confirm",
        "An explicit reason and confirmation are required",
      );
    reader.done();
    return this.run(() =>
      this.source.transaction(async (manager) => {
        await assertMediaAdministrator(manager, actor);
        const existing = await readMediaSource(manager, id, true);
        if (existing && existing.workspace_id !== actor.workspace_id)
          mediaSupplierError(
            "Media source is unavailable in this workspace",
            404,
          );
        if (existing ? existing.revision !== revision : revision !== 0)
          mediaSupplierError("Media source revision changed");
        const disabling = Boolean(existing && !enabled);
        if (existing && (existing.node_id !== nodeId || existing.credential_id !== credentialId))
          mediaSupplierError("Create another source for a different provider identity; do not retarget historical events");
        if (disabling && existing!.secret_env !== secretEnv)
          mediaSupplierError("Disable with the original signing variable; rotate it separately");
        const node=this.config.getNode(nodeId);
        if(!disabling && !node)mediaSupplierError("Media source node is not configured",400);
        const connection=disabling?existing!.connection_hash:this.tasks.connectionHash(node!);
        if(existing && !disabling && existing.connection_hash!==connection)
          mediaSupplierError("Create another source for a different provider identity; do not retarget historical events");
        // Revocation must remain possible after node removal or key loss. It
        // preserves historical identity and does not activate a replacement.
        const secret=process.env[secretEnv];
        if(enabled&&(!secret||Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>4096))
          mediaSupplierError("Dedicated media-event signing key is unavailable or invalid",400);
        const now = new Date().toISOString(),
          row: MediaSupplierSource = {
            id,
            workspace_id: actor.workspace_id,
            node_id: nodeId,
            credential_id: credentialId,
            connection_hash: connection,
            secret_env: secretEnv,
            revision: revision + 1,
            enabled: enabled ? 1 : 0,
            config_hash: "",
            audit_id: randomUUID(),
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };
        row.config_hash = mediaSourceHash(row);
        await manager
          .createQueryBuilder()
          .insert()
          .into("pricing_audit_events")
          .values({
            id: row.audit_id,
            workspace_id: actor.workspace_id,
            book_id: null,
            actor_id: actor.id,
            action: "media.source_updated",
            reason,
            metadata_json: JSON.stringify({
              source_id: id,
              config_hash: row.config_hash,
              revision: row.revision,
              enabled,
            }),
            created_at: now,
          })
          .execute();
        if (existing)
          await manager
            .createQueryBuilder()
            .update("pricing_media_event_sources")
            .set(row)
            .where(
              "id = :id AND workspace_id = :workspace AND revision = :revision",
              { id, workspace: actor.workspace_id, revision },
            )
            .execute();
        else
          await manager
            .createQueryBuilder()
            .insert()
            .into("pricing_media_event_sources")
            .values(row)
            .execute();
        return row;
      }),
    );
  }
  async sourceDetail(actor:PricingActor,id:string){
    requireMediaOperator(actor);await this.available();return this.run(async()=>{
      const source=await readMediaSource(this.source.manager,id);
      if(!source||source.workspace_id!==actor.workspace_id)mediaSupplierError("Media source is unavailable in this workspace",404);
      return source;
    });
  }
  async sources(
    actor: PricingActor,
    options: MediaPageOptions = { limit: 100 },
  ) {
    requireMediaOperator(actor);
    await this.available();
    const after = mediaCursor(options, actor.workspace_id, "sources");
    return this.run(async () => {
      const query = this.source.manager
        .createQueryBuilder()
        .select("s.id", "id")
        .addSelect("s.created_at", "created_at")
        .from("pricing_media_event_sources", "s")
        .where("s.workspace_id = :workspace", {
          workspace: actor.workspace_id,
        });
      if (after)
        query.andWhere(
          "(s.created_at > :time OR (s.created_at = :time AND s.id > :id))",
          { time: after.time, id: after.id },
        );
      const rows = await query
          .orderBy("s.created_at", "ASC")
          .addOrderBy("s.id", "ASC")
          .limit(options.limit + 1)
          .getRawMany<{ id: string; created_at: string }>(),
        page = rows.slice(0, options.limit),
        sources = [];
      for (const row of page)
        sources.push(await readMediaSource(this.source.manager, row.id));
      const last = page.at(-1);
      return {
        sources,
        has_more: rows.length > options.limit,
        limit: options.limit,
        next_cursor:
          rows.length > options.limit && last
            ? nextMediaCursor(
                actor.workspace_id,
                "sources",
                last.id,
                last.created_at,
              )
            : null,
      };
    });
  }
  async inventory(
    actor: PricingActor,
    options: MediaPageOptions & { view: MediaTaskView },
  ) {
    requireMediaOperator(actor);
    await this.available();
    return this.run(() =>
      mediaTaskInventory(this.source.manager, actor.workspace_id, options),
    );
  }
  async detail(actor: PricingActor, taskId: string) {
    requireMediaOperator(actor);
    await this.available();
    const task = await this.tasks.get(taskId, actor.workspace_id);
    if (!task)
      mediaSupplierError("Media task is unavailable in this workspace", 404);
    const ledger = await this.ledger.summary(
      task.request_id,
      actor.workspace_id,
    );
    return { task: mediaTaskSummary(task), ledger };
  }
  async receive(
    sourceId: string,
    body: unknown,
    auth: MediaSupplierAuthentication,
  ) {
    await this.available();
    const event = parseMediaSupplierEvent(body);
    const source = await this.run(() =>
      readMediaSource(this.source.manager, sourceId),
    );
    if (!source) mediaSupplierError("Media event authentication failed", 401);
    authenticateMediaSupplierEvent(
      source,
      event,
      auth,
      process.env[source.secret_env],
    );
    const reply = await this.tasks.receiveSupplierEvent(source, event);
    let processingPending = false;
    try {
      await this.tasks.process(event.task_id, source.workspace_id);
      processingPending = await this.tasks.hasPendingFinancialProcessing(event.task_id, source.workspace_id);
    } catch {
      processingPending = true;
    }
    return { ...reply, processing_pending: processingPending };
  }
  async events(
    actor: PricingActor,
    taskId: string,
    options: MediaPageOptions = { limit: 100 },
  ) {
    requireMediaOperator(actor);
    await this.available();
    const kind = `events:${taskId}`,
      after = mediaCursor(options, actor.workspace_id, kind);
    return this.run(async () => {
      const query = this.source.manager
        .createQueryBuilder()
        .select("e.*")
        .from("pricing_media_supplier_events", "e")
        .where("e.task_id = :task AND e.workspace_id = :workspace", {
          task: taskId,
          workspace: actor.workspace_id,
        });
      if (after)
        query.andWhere(
          "(e.created_at > :time OR (e.created_at = :time AND e.id > :id))",
          { time: after.time, id: after.id },
        );
      const rows = await query
          .orderBy("e.created_at", "ASC")
          .addOrderBy("e.id", "ASC")
          .limit(options.limit + 1)
          .getRawMany<MediaSupplierEventRow>(),
        page = rows.slice(0, options.limit),
        events = [];
      for (const row of page) {
        await verifyMediaEventRecord(this.source.manager, row);
        const disposition = await readMediaDispositionRecord(this.source.manager, actor.workspace_id, taskId, row.id);
        events.push({ ...mediaEventReply(row), created_at: row.created_at, disposition: disposition ? {
          id: disposition.row.operation_id, action: disposition.row.action, actor_id: disposition.row.actor_id, record_hash: disposition.row.record_hash,
        } : null });
      }
      const last = page.at(-1);
      return {
        events,
        has_more: rows.length > options.limit,
        limit: options.limit,
        next_cursor:
          rows.length > options.limit && last
            ? nextMediaCursor(
                actor.workspace_id,
                kind,
                last.id,
                last.created_at,
              )
            : null,
      };
    });
  }
  async event(actor: PricingActor, taskId: string, id: string) {
    requireMediaOperator(actor);
    await this.available();
    return this.run(async () => {
      const row = await this.source.manager
        .createQueryBuilder()
        .select("e.*")
        .from("pricing_media_supplier_events", "e")
        .where(
          "e.id = :id AND e.task_id = :task AND e.workspace_id = :workspace",
          { id, task: taskId, workspace: actor.workspace_id },
        )
        .getRawOne<MediaSupplierEventRow>();
      if (!row)
        mediaSupplierError("Media event is unavailable in this workspace", 404);
      await verifyMediaEventRecord(this.source.manager, row);
      const disposition = await readMediaDispositionRecord(this.source.manager, actor.workspace_id, taskId, row.id);
      return {
        ...mediaEventReply(row),
        disposition: disposition?.receipt ?? null,
        document: JSON.parse(row.document_json) as unknown,
        created_at: row.created_at,
      };
    });
  }
}
