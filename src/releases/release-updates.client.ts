import { PublicRelease, RELEASES_URL, RELEASE_PAGE, isNewer, versionParts } from './release-updates.types';
const MAX_BYTES = 2 * 1024 * 1024;
export class UpdateFetchError extends Error {
  constructor(public readonly code: 'network' | 'rate_limited' | 'invalid_response', public readonly retryAt: number | null = null) { super(code); }
}
export function parseReleases(input: unknown): PublicRelease | null {
  if (!Array.isArray(input) || input.length > 20) throw new UpdateFetchError('invalid_response');
  let latest: PublicRelease | null = null;
  for (const r of input) {
    if (!r || typeof r !== 'object' || r.draft !== false || r.prerelease !== false || typeof r.tag_name !== 'string') continue;
    const version = r.tag_name.startsWith('v') ? r.tag_name.slice(1) : '';
    if (!versionParts(version) || r.html_url !== `${RELEASE_PAGE}/tag/v${version}` || typeof r.published_at !== 'string' || !Number.isFinite(Date.parse(r.published_at))) continue;
    if (!Array.isArray(r.assets) || r.assets.length > 100) continue;
    const names = new Set(r.assets.filter((a: any) => a && a.state === 'uploaded' && Number.isSafeInteger(a.size) && a.size > 0).map((a: any) => a.name));
    // Asset presence is only discovery, never publisher/compatibility verification.
    if (!['-install.tar.gz', '-install.tar.gz.sha256', '-release.json', '-release.sigstore.jsonl'].every(s => names.has(`siftgate-v${version}${s}`))) continue;
    const release: PublicRelease = { version, name: typeof r.name === 'string' ? r.name.slice(0, 200) : `v${version}`,
      published_at: r.published_at, url: r.html_url, notes: typeof r.body === 'string' ? r.body.slice(0, 6000) : '',
      publisher_verified: false, compatibility: 'not_checked' };
    if (!latest || isNewer(release.version, latest.version)) latest = release;
  }
  return latest;
}
export async function fetchPublicRelease(fetcher: typeof fetch, signal: AbortSignal, etag: string | null, now: number) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SiftGate-release-notices' };
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetcher(RELEASES_URL, { headers, method: 'GET', redirect: 'error', credentials: 'omit', signal });
  if (response.status === 403 || response.status === 429) {
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const date = retry ? Date.parse(retry) : NaN;
    const requested = seconds !== null ? now + seconds * 1000 : Number.isFinite(date) ? date : reset;
    await response.body?.cancel();
    throw new UpdateFetchError('rate_limited', Math.min(now + 86400000, Math.max(now + 60000, Number.isFinite(requested) ? requested : now + 3600000)));
  }
  if (response.status === 304) { await response.body?.cancel(); return { unchanged: true as const, etag, latest: null }; }
  if (!response.ok) { await response.body?.cancel(); throw new UpdateFetchError('network'); }
  const reader = response.body?.getReader();
  if (!reader) throw new UpdateFetchError('invalid_response');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_BYTES) throw new UpdateFetchError('invalid_response');
      chunks.push(part.value);
    }
    const result = parseReleases(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const rawEtag = response.headers.get('etag');
    return { unchanged: false as const, latest: result, etag: rawEtag && /^[\x20-\x7e]{1,200}$/.test(rawEtag) ? rawEtag : null };
  } catch (error) { if (error instanceof UpdateFetchError) throw error; throw new UpdateFetchError('invalid_response'); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
