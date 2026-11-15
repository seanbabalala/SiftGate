import { MediaIdempotency } from '../../src/providers/media-idempotency';
import type { CanonicalMediaRequest } from '../../src/canonical/canonical.types';
import type { NodeConfig } from '../../src/config/gateway.config';

const node = { id: 'image-node', media_idempotency: true } as NodeConfig;
function request(header?: string): CanonicalMediaRequest {
  return {
    model: 'image', source_format: 'image_generation', payload: { model: 'image', prompt: 'PRIVATE' },
    content_type: 'application/json', is_multipart: false,
    media: { media_type: 'image', operation: 'generation', multipart: false, file_count: 0, byte_size: 40, requested_format: null, response_format: null },
    metadata: { source_format: 'image_generation', workspace_id: 'workspace', api_key_id: 'caller-1',
      raw_headers: { authorization: 'Bearer GATEWAY_SECRET', ...(header === undefined ? {} : { 'idempotency-key': header }) } },
  };
}

describe('opt-in media idempotency', () => {
  it('leaves all existing nodes unchanged by default', () => {
    expect(new MediaIdempotency().headers(request('test'), { ...node, media_idempotency: undefined })).toEqual({});
  });
  it('scopes stable client keys without leaking identity or credentials', () => {
    const h = new MediaIdempotency();
    const first = h.headers(request('client-key'), node);
    expect(first).toEqual(new MediaIdempotency().headers(request('client-key'), node));
    expect(Object.keys(first)).toEqual(['Idempotency-Key']);
    expect(first['Idempotency-Key']).toMatch(/^sg_media_[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toMatch(/caller|SECRET|PRIVATE|client-key/);
  });
  it('isolates callers, workspaces, namespaces, nodes and operations', () => {
    const h = new MediaIdempotency(), first = h.headers(request('same'), node);
    for (const metadata of [{ api_key_id: 'caller-2' }, { workspace_id: 'other' }, { namespace_id: 'other' }]) {
      const req = request('same'); Object.assign(req.metadata, metadata);
      expect(h.headers(req, node)).not.toEqual(first);
    }
    expect(h.headers(request('same'), { ...node, id: 'other' })).not.toEqual(first);
    const req = request('same'); req.source_format = 'image_edit';
    expect(h.headers(req, node)).not.toEqual(first);
  });
  it('synthesizes once per request, not once per transport attempt', () => {
    const h = new MediaIdempotency(), req = request();
    expect(h.headers(req, node)).toEqual(h.headers(req, node));
    expect(h.headers(req, node)).not.toEqual(h.headers(request(), node));
  });
  it('does not hide payload changes under a new key', () => {
    const h = new MediaIdempotency(), a = request('same'), b = request('same');
    b.payload = { model: 'image', prompt: 'Different' };
    expect(h.headers(a, node)).toEqual(h.headers(b, node));
  });
  it('rejects malformed keys and missing trusted identity before dispatch', () => {
    const h = new MediaIdempotency();
    for (const key of ['', 'a\nb', 'contains space', 'x'.repeat(257), '汉字']) expect(() => h.headers(request(key), node)).toThrow();
    const req = request(); delete req.metadata.api_key_id;
    expect(() => h.headers(req, node)).toThrow();
  });
});
