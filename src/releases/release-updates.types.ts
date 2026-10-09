export const RELEASE_REPOSITORY = 'seanbabalala/SiftGate';
export const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=20`;
export const RELEASE_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export const UPDATE_INTERVALS = [6, 12, 24] as const;
export type UpdateError = 'network' | 'rate_limited' | 'invalid_response' | 'storage_unavailable';
export interface PublicRelease {
  version: string; name: string; published_at: string; url: string; notes: string;
  publisher_verified: false; compatibility: 'not_checked';
}
export interface UpdateState {
  format: 'siftgate-release-updates-v1';
  enabled: boolean; interval_hours: number; notify_connectors: boolean;
  last_attempt_at: number | null; last_success_at: number | null; next_check_at: number | null;
  retry_after: number | null; error: UpdateError | null; failures: number;
  etag: string | null; latest: PublicRelease | null; notified_version: string | null;
}
export const initialUpdateState = (): UpdateState => ({
  format: 'siftgate-release-updates-v1', enabled: true, interval_hours: 6, notify_connectors: false,
  last_attempt_at: null, last_success_at: null, next_check_at: null, retry_after: null,
  error: null, failures: 0, etag: null, latest: null, notified_version: null,
});
export function versionParts(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) return null;
  return value.split('.').map(Number);
}
export function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function publicRelease(value: unknown): value is PublicRelease {
  const r = value as PublicRelease | null;
  return !!r && !!versionParts(r.version) && r.url === `${RELEASE_PAGE}/tag/v${r.version}` &&
    typeof r.name === 'string' && r.name.length <= 200 && typeof r.notes === 'string' && r.notes.length <= 6000 &&
    typeof r.published_at === 'string' && Number.isFinite(Date.parse(r.published_at)) &&
    r.publisher_verified === false && r.compatibility === 'not_checked';
}
export function validateUpdateState(value: unknown): UpdateState {
  const s = value as UpdateState;
  if (!s || s.format !== 'siftgate-release-updates-v1' || typeof s.enabled !== 'boolean' ||
      typeof s.notify_connectors !== 'boolean' || !(UPDATE_INTERVALS as readonly number[]).includes(s.interval_hours) ||
      ![null, 'network', 'rate_limited', 'invalid_response', 'storage_unavailable'].includes(s.error) ||
      !Number.isSafeInteger(s.failures) || s.failures < 0 || s.failures > 100 ||
      ![s.last_attempt_at, s.last_success_at, s.next_check_at, s.retry_after].every(v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000)) ||
      !(s.etag === null || (typeof s.etag === 'string' && /^[\x20-\x7e]{1,200}$/.test(s.etag))) ||
      !(s.notified_version === null || versionParts(s.notified_version)) || !(s.latest === null || publicRelease(s.latest))) {
    throw new Error('invalid_update_cache');
  }
  return { ...initialUpdateState(), ...s };
}
