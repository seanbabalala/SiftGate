import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createE2EHarness, E2EHarness } from './setup';
import { AuthService } from '../../src/auth/auth.service';

describe('Operator observation API', () => {
  let h: E2EHarness; let directory: string;
  const oldPath = process.env.SIFTGATE_OPERATOR_STATUS_PATH;
  const oldId = process.env.SIFTGATE_OPERATOR_INSTALLATION_ID;
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-operator-e2e-'));
    process.env.SIFTGATE_OPERATOR_STATUS_PATH = path.join(directory, 'status.json');
    process.env.SIFTGATE_OPERATOR_INSTALLATION_ID = 'a'.repeat(32);
    fs.writeFileSync(process.env.SIFTGATE_OPERATOR_STATUS_PATH, JSON.stringify({ format:'siftgate-operator-status-v1',
      installation_id:'a'.repeat(32), generated_at:new Date().toISOString(), executor:{online:false,heartbeat_at:null},
      approval_channel:'host_owner_cli_only',image_verification:'digest_and_manual_owner_review_not_publisher_signature',jobs:[] }), {mode:0o600});
    h = await createE2EHarness();
  }, 30000);
  afterAll(async () => {
    await h?.close(); fs.rmSync(directory, {recursive:true,force:true});
    if (oldPath === undefined) delete process.env.SIFTGATE_OPERATOR_STATUS_PATH; else process.env.SIFTGATE_OPERATOR_STATUS_PATH=oldPath;
    if (oldId === undefined) delete process.env.SIFTGATE_OPERATOR_INSTALLATION_ID; else process.env.SIFTGATE_OPERATOR_INSTALLATION_ID=oldId;
  });
  it('reads an independent offline operator without opening a command channel', async () => {
    const response=await h.agent.get('/api/dashboard/operator/status');
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.state).toBe('offline'); expect(response.body.scope).toBe('instance_metadata');
    expect(response.body.operator.approval_channel).toBe('host_owner_cli_only');
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('has no upgrade, approval, restart or write endpoint', async () => {
    for (const route of ['status','approve','upgrade','restart']) {
      const response=await h.agent.post('/api/dashboard/operator/'+route).send({command:'do-not-execute'});
      expect(response.status).toBe(404);
    }
  });
  it('requires Dashboard administrator access, not only a valid session', async () => {
    const auth=h.app.get(AuthService);
    const required=jest.spyOn(auth,'isAuthRequired','get').mockReturnValue(true);
    const verify=jest.spyOn(auth,'verifyToken').mockReturnValue({sub:'no-host-authority'});
    try { expect((await h.agent.get('/api/dashboard/operator/status').set('Authorization','Bearer synthetic')).status).toBe(403); }
    finally { required.mockRestore(); verify.mockRestore(); }
  });
  it('fails closed and redacts diagnostics when the binding changes', async () => {
    process.env.SIFTGATE_OPERATOR_INSTALLATION_ID='b'.repeat(32);
    const response=await h.agent.get('/api/dashboard/operator/status');
    expect(response.body).toEqual({state:'unavailable',scope:'instance_metadata',operator:null});
    expect(JSON.stringify(response.body)).not.toContain(directory);
  });
});
