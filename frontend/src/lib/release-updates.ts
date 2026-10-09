import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api'
export interface ReleaseUpdates {
  state: string; current_version: string; enabled: boolean; host_disabled: boolean;
  interval_hours: number; notify_connectors: boolean; last_attempt_at: number | null;
  last_success_at: number | null; next_check_at: number | null; retry_after: number | null;
  error: string | null; stale: boolean; update_available: boolean;
  latest: null | { version: string; name: string; published_at: string; url: string; notes: string; publisher_verified: false; compatibility: 'not_checked' };
  release_page: string; automatic_install: false; publisher_verified: false;
}
export const RELEASE_UPDATE_KEY = ['release-update-notices'] as const
export function useReleaseUpdates() {
  return useQuery({ queryKey: RELEASE_UPDATE_KEY, queryFn: () => apiGet<ReleaseUpdates>('/api/dashboard/release-updates'),
    staleTime: 60000, refetchInterval: 60000, refetchIntervalInBackground: false, retry: false })
}
// Do not trust a server-provided external destination, including one from a stale browser cache.
export function releaseNotesUrl(version: string): string | null {
  return /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)
    ? `https://github.com/seanbabalala/SiftGate/releases/tag/v${version}` : null
}
