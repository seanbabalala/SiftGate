import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OperatorStatusService } from '../../src/operator/operator-status.service';

const instance = 'a'.repeat(32);
export function operatorFrame() {
  const now = new Date().toISOString();
  return { format: 'siftgate-operator-status-v1', installation_id: instance, generated_at: now,
    executor: { online: true, heartbeat_at: now }, approval_channel: 'host_owner_cli_only',
    image_verification: 'digest_and_manual_owner_review_not_publisher_signature',
    jobs: [{ id: 'op-' + 'b'.repeat(32), operation: 'backup', status: 'succeeded', stage: 'complete', revision: 9,
      plan_digest: 'c'.repeat(64), source_image: 'sha256:' + 'd'.repeat(64), target_image: null,
      trust: 'installed_image', created_at: now, updated_at: now, error_code: null,
      approval: { uid: 501, approved_at: now, not_before: now, not_after: now, accepted_downtime: true },
      checkpoint: { id: 'backup-' + 'e'.repeat(32), checksums_verified: true, restore_drill_verified: false },
      events: [{ stage: 'complete', at: now, event: 'completed' }] }] };
}

describe('Read-only host operator status bridge', () => {
  let directory: string; let file: string;
  const originalPath = process.env.SIFTGATE_OPERATOR_STATUS_PATH;
  const originalIdentity = process.env.SIFTGATE_OPERATOR_INSTALLATION_ID;
  const service = new OperatorStatusService();
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-operator-status-'));
    file = path.join(directory, 'status.json');
    process.env.SIFTGATE_OPERATOR_STATUS_PATH = file;
    process.env.SIFTGATE_OPERATOR_INSTALLATION_ID = instance;
  });
  afterEach(() => {
    for (const [name, value] of [['SIFTGATE_OPERATOR_STATUS_PATH', originalPath], ['SIFTGATE_OPERATOR_INSTALLATION_ID', originalIdentity]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  it('does not access a file without explicit path and installation binding', async () => {
    delete process.env.SIFTGATE_OPERATOR_INSTALLATION_ID;
    expect((await service.read()).state).toBe('unconfigured');
  });
  it('returns only allowlisted metadata, never the private plan or arbitrary fields', async () => {
    const frame = operatorFrame() as any;
    frame.secret = 'NEVER_RETURN'; frame.jobs[0].plan = { private_path: '/private/NEVER_RETURN' };
    frame.jobs[0].events[0].payload = 'NEVER_RETURN'; frame.jobs[0].approval.password = 'NEVER_RETURN';
    write(frame);
    const status = await service.read();
    expect(status.state).toBe('online');
    expect(status.operator?.jobs[0].checkpoint?.restore_drill_verified).toBe(false);
    expect(JSON.stringify(status)).not.toContain('NEVER_RETURN');
  });
  it('projects independent Control review and dispatch without suggesting CLI authority only', async () => {
    const frame = operatorFrame() as any;
    frame.approval_channel = 'host_owner_or_independent_control';
    frame.jobs[0].control_job_id = 'job-' + 'f'.repeat(32);
    frame.jobs[0].events = [{ stage: 'planned', event: 'control_review_recorded', at: frame.generated_at },
      { stage: 'queued', event: 'approved_by_control', at: frame.generated_at }];
    write(frame);
    const result = await service.read();
    expect(result.state).toBe('online');
    expect(result.operator?.approval_channel).toBe('host_owner_or_independent_control');
    expect(result.operator?.jobs[0].control_job_id).toBe(frame.jobs[0].control_job_id);
    frame.jobs[0].control_job_id = '../secret'; write(frame);
    expect((await service.read()).state).toBe('unavailable');
  });
  it.each(['foreign', 'future', 'stale', 'offline'])('handles %s identity/heartbeat honestly', async kind => {
    const frame = operatorFrame();
    if (kind === 'foreign') frame.installation_id = 'f'.repeat(32);
    if (kind === 'future') frame.generated_at = new Date(Date.now() + 60000).toISOString();
    if (kind === 'stale') frame.executor.heartbeat_at = new Date(Date.now() - 60000).toISOString();
    if (kind === 'offline') frame.executor.online = false;
    write(frame);
    expect((await service.read()).state).toBe(kind === 'foreign' ? 'unavailable' : kind === 'offline' ? 'offline' : 'stale');
  });
  it.each(['image', 'job', 'command', 'drill', 'many', 'revision'])('rejects malformed %s instead of trusting a status file', async kind => {
    const frame = operatorFrame() as any;
    if (kind === 'image') frame.jobs[0].source_image = '$(do-not-execute)';
    if (kind === 'job') frame.jobs[0].id = '../private';
    if (kind === 'command') frame.jobs[0].events[0].event = 'shell';
    if (kind === 'drill') frame.jobs[0].checkpoint.restore_drill_verified = true;
    if (kind === 'many') frame.jobs = Array(21).fill(frame.jobs[0]);
    if (kind === 'revision') frame.jobs[0].revision = -1;
    write(frame); expect((await service.read()).state).toBe('unavailable');
  });
  it('refuses symbolic links, unsafe permissions, oversized and corrupt files', async () => {
    const privateFile = path.join(directory, 'private.json');
    fs.writeFileSync(privateFile, JSON.stringify(operatorFrame()), { mode: 0o600 });
    fs.symlinkSync(privateFile, file);
    expect((await service.read()).state).toBe('unavailable');
    fs.unlinkSync(file); write(operatorFrame()); fs.chmodSync(file, 0o644);
    expect((await service.read()).state).toBe('unavailable');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    expect((await service.read()).state).toBe('unavailable');
    fs.writeFileSync(file, '{'); expect((await service.read()).state).toBe('unavailable');
  });
  it('rejects a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', [file]);
    fs.chmodSync(file, 0o600);
    expect((await service.read()).state).toBe('unavailable');
  });
  it('rejects hard-linked status files', async () => {
    write(operatorFrame());
    fs.linkSync(file, path.join(directory, 'another-name.json'));
    expect((await service.read()).state).toBe('unavailable');
  });
  it('bounds reads even when the size observed by stat is stale', async () => {
    write(operatorFrame());
    const handle = await fs.promises.open(file, 'r');
    const original = await handle.stat();
    fs.appendFileSync(file, ' '.repeat(256 * 1024));
    const stat = jest.spyOn(handle, 'stat').mockResolvedValue(original);
    const open = jest.spyOn(fs.promises, 'open').mockResolvedValue(handle);
    try { expect((await service.read()).state).toBe('unavailable'); }
    finally { stat.mockRestore(); open.mockRestore(); }
  });
});
