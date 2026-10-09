import { createE2EHarness, E2EHarness } from './setup';
import { AuthService } from '../../src/auth/auth.service';
import { RELEASE_PAGE, RELEASES_URL } from '../../src/releases/release-updates.types';

describe('release update notice API', () => {
  let h: E2EHarness;
  beforeAll(async () => { h = await createE2EHarness(); }, 30000);
  afterAll(async () => { await h?.close(); }, 30000);
  it('reads cached status with no network request or deployment API', async () => {
    const r = await h.agent.get('/api/dashboard/release-updates');
    expect(r.status).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ state: 'not_checked', automatic_install: false, publisher_verified: false });
    expect(h.fetchMock.calls).toHaveLength(0);
    for (const action of ['upgrade','pull','restart','install']) expect((await h.agent.post('/api/dashboard/release-updates/'+action).send({})).status).toBe(404);
  });
  it('rejects cross-origin actions before sending any request', async () => {
    expect((await h.agent.post('/api/dashboard/release-updates/check').set('Origin','https://attacker.invalid').send({})).status).toBe(403);
    expect((await h.agent.put('/api/dashboard/release-updates/preferences').set('Sec-Fetch-Site','cross-site').send({enabled:false,interval_hours:6,notify_connectors:false})).status).toBe(403);
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('rejects unknown preferences and permits an administrator to disable checks', async () => {
    expect((await h.agent.put('/api/dashboard/release-updates/preferences').send({enabled:true,interval_hours:1,notify_connectors:false})).status).toBe(400);
    const r = await h.agent.put('/api/dashboard/release-updates/preferences').send({enabled:false,interval_hours:12,notify_connectors:false});
    expect(r.status).toBe(200); expect(r.body.state).toBe('disabled');
    expect((await h.agent.post('/api/dashboard/release-updates/check').send({})).body.state).toBe('disabled');
    expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('only contacts the fixed public metadata endpoint and reports an unverified notice', async () => {
    h.fetchMock.setHandler(async url => {
      expect(url).toBe(RELEASES_URL);
      return new Response(JSON.stringify([{tag_name:'v2.13.0',draft:false,prerelease:false,name:'Synthetic release',body:'<script>text only</script>',published_at:'2026-10-09T00:00:00Z',html_url:RELEASE_PAGE+'/tag/v2.13.0',assets:['-install.tar.gz','-install.tar.gz.sha256','-release.json','-release.sigstore.jsonl'].map(s=>({name:'siftgate-v2.13.0'+s,size:100,state:'uploaded'}))}]),{status:200,headers:{etag:'"test"'}});
    });
    await h.agent.put('/api/dashboard/release-updates/preferences').send({enabled:true,interval_hours:6,notify_connectors:false});
    const r = await h.agent.post('/api/dashboard/release-updates/check').send({});
    expect(r.status).toBe(201); expect(r.body).toMatchObject({state:'available',update_available:true,automatic_install:false,latest:{version:'2.13.0',publisher_verified:false,compatibility:'not_checked'}});
    expect(h.fetchMock.calls).toHaveLength(1);
    expect(h.fetchMock.calls[0].headers).not.toHaveProperty('Authorization');
    expect((await h.agent.post('/api/dashboard/release-updates/check').send({})).status).toBe(429);
    await h.agent.get('/api/dashboard/release-updates'); expect(h.fetchMock.calls).toHaveLength(1);
  });
  it('requires administrator membership for mutation, not just a valid dashboard session', async () => {
    const auth = h.app.get(AuthService);
    const required = jest.spyOn(auth,'isAuthRequired','get').mockReturnValue(true);
    const verify = jest.spyOn(auth,'verifyToken').mockReturnValue({sub:'release-viewer'});
    const scope = await h.workspaceRepo.findOneByOrFail({slug:'default'}).catch(()=>h.workspaceRepo.findOneByOrFail({id:'default-workspace'}));
    await h.membershipRepo.save(h.membershipRepo.create({user_id:'release-viewer',organization_id:scope.organization_id,workspace_id:scope.id,role:'viewer',status:'active'}));
    try {
      expect((await h.agent.get('/api/dashboard/release-updates').set('Authorization','Bearer synthetic')).status).toBe(200);
      expect((await h.agent.post('/api/dashboard/release-updates/check').set('Authorization','Bearer synthetic').send({})).status).toBe(403);
      expect((await h.agent.put('/api/dashboard/release-updates/preferences').set('Authorization','Bearer synthetic').send({enabled:false,interval_hours:6,notify_connectors:false})).status).toBe(403);
    } finally { required.mockRestore(); verify.mockRestore(); }
  });
});
