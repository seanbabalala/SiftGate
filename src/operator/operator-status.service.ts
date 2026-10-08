import { Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const states = new Set(['planned', 'queued', 'running', 'succeeded', 'rejected', 'needs_attention', 'cancelled', 'resolved']);
const stages = new Set(['planned', 'queued', 'preflight', 'candidate_check', 'maintenance', 'stopping', 'snapshot', 'switching', 'starting', 'verifying', 'complete', 'interrupted']);
const events = new Set(['created', 'entered', 'approved_by_host_owner', 'control_review_recorded', 'approved_by_control', 'started', 'snapshot_verified', 'completed', 'rejected', 'rejected_before_maintenance', 'manual_reconciliation_required', 'cancelled_before_execution', 'host_owner_confirmed_reconciliation']);
const image = /^sha256:[a-f0-9]{64}$/;
const jobId = /^op-[a-f0-9]{32}$/;
const sha = /^[a-f0-9]{64}$/;
const MAX_STATUS_BYTES = 256 * 1024;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function required(value: unknown): asserts value { if (!value) throw new Error('invalid_operator_status'); }

/** Read-only, instance-bound bridge. No Docker/Unix-socket client, exec, writes or commands. */
@Injectable()
export class OperatorStatusService {
  async read() {
    const location = process.env.SIFTGATE_OPERATOR_STATUS_PATH;
    const identity = process.env.SIFTGATE_OPERATOR_INSTALLATION_ID;
    if (!location || !identity) return { state: 'unconfigured' as const, scope: 'instance_metadata', operator: null };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      required(/^[a-f0-9]{32}$/.test(identity));
      // A FIFO must not wait for a writer before we can reject it with fstat.
      file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      required(info.isFile() && info.nlink === 1 && info.size <= MAX_STATUS_BYTES && (info.mode & 0o077) === 0);
      // Bound allocation and reads even if the file grows after fstat. The host
      // writer uses atomic replacement; an over-limit/incomplete frame fails closed.
      const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      required(length <= MAX_STATUS_BYTES);
      const raw = buffer.subarray(0, length).toString('utf8');
      const data: unknown = JSON.parse(raw);
      required(record(data) && data.format === 'siftgate-operator-status-v1' && data.installation_id === identity && date(data.generated_at));
      required(record(data.executor) && typeof data.executor.online === 'boolean' && (data.executor.heartbeat_at === null || date(data.executor.heartbeat_at)));
      required(['host_owner_cli_only', 'host_owner_or_independent_control'].includes(data.approval_channel as string) && ['digest_and_manual_owner_review_not_publisher_signature', 'attestation_for_managed_upgrades_manual_development_only'].includes(data.image_verification as string));
      required(Array.isArray(data.jobs) && data.jobs.length <= 20);
      const jobs = data.jobs.map((job: unknown) => this.job(job));
      const age = Date.now() - Date.parse(data.generated_at);
      const heartbeatAge = data.executor.heartbeat_at ? Date.now() - Date.parse(data.executor.heartbeat_at) : Infinity;
      const stale = age < -5000 || age > 30000 || (data.executor.online && (heartbeatAge < -5000 || heartbeatAge > 30000));
      return { state: stale ? 'stale' as const : data.executor.online ? 'online' as const : 'offline' as const,
        scope: 'instance_metadata', operator: { generated_at: data.generated_at, installation_id: identity,
          heartbeat_at: data.executor.heartbeat_at, approval_channel: data.approval_channel as string,
          image_verification: data.image_verification as string, jobs } };
    } catch {
      // Never return raw JSON, private file paths, parser errors or environment values.
      return { state: 'unavailable' as const, scope: 'instance_metadata', operator: null };
    } finally { await file?.close(); }
  }

  private job(value: unknown) {
    required(record(value)); const job = value;
    required(typeof job.id === 'string' && jobId.test(job.id) && ['backup', 'upgrade'].includes(job.operation));
    required(states.has(job.status) && stages.has(job.stage) && Number.isSafeInteger(job.revision) && job.revision > 0);
    required(typeof job.plan_digest === 'string' && sha.test(job.plan_digest) && image.test(job.source_image) && (job.target_image === null || (typeof job.target_image === 'string' && image.test(job.target_image))));
    required(date(job.created_at) && date(job.updated_at));
    const controlJobId = job.control_job_id ?? null;
    required(controlJobId === null || (typeof controlJobId === 'string' && /^job-[a-f0-9]{32}$/.test(controlJobId)));
    required(['installed_image', 'local_development', 'digest_only_manual_publisher_review', 'publisher_attested'].includes(job.trust));
    required(job.error_code === null || (typeof job.error_code === 'string' && /^[a-z_]{1,80}$/.test(job.error_code)));
    required(Array.isArray(job.events) && job.events.length <= 32);
    const timeline = job.events.map((event: unknown) => {
      required(record(event) && stages.has(event.stage) && events.has(event.event) && date(event.at));
      return { stage: event.stage as string, event: event.event as string, at: event.at };
    });
    let approval: null | { uid: number; approved_at: string; not_before: string; not_after: string } = null;
    if (job.approval !== null) {
      const a = job.approval;
      required(record(a) && Number.isSafeInteger(a.uid) && a.uid >= 0 && date(a.approved_at) && date(a.not_before) && date(a.not_after) && a.accepted_downtime === true);
      approval = { uid: a.uid, approved_at: a.approved_at, not_before: a.not_before, not_after: a.not_after };
    }
    let checkpoint: null | { id: string; checksums_verified: boolean; restore_drill_verified: boolean } = null;
    if (job.checkpoint !== null) {
      const c = job.checkpoint;
      required(record(c) && typeof c.id === 'string' && /^backup-[a-f0-9-]{1,64}$/.test(c.id) && typeof c.checksums_verified === 'boolean' && c.restore_drill_verified === false);
      checkpoint = { id: c.id, checksums_verified: c.checksums_verified, restore_drill_verified: false };
    }
    return { id: job.id, operation: job.operation as 'backup' | 'upgrade', status: job.status as string, stage: job.stage as string,
      revision: job.revision as number, plan_digest: job.plan_digest as string, created_at: job.created_at, updated_at: job.updated_at,
      source_image: job.source_image as string, target_image: job.target_image as string | null, trust: job.trust as string, control_job_id: controlJobId as string | null,
      approval, checkpoint, error_code: job.error_code as string | null, events: timeline };
  }
}
