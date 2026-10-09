const ReleaseUpdatesPage = lazy(() => import('@/pages/ReleaseUpdatesPage').then(m => ({ default: m.ReleaseUpdatesPage })))
import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/shared/ProtectedRoute'
import { Skeleton, SkeletonCard, SkeletonTable } from '@/components/ui/skeleton'

const ControlRoomPage = lazy(() => import('@/pages/ControlRoomPage').then(module => ({default:module.ControlRoomPage})))
const LaunchpadPage = lazy(() => import('@/pages/LaunchpadPage').then(module => ({default:module.LaunchpadPage})))
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const AlertConnectorsPage = lazy(() => import('@/pages/AlertConnectorsPage').then((m) => ({ default: m.AlertConnectorsPage })))
const LogsPage = lazy(() => import('@/pages/LogsPage').then((m) => ({ default: m.LogsPage })))
const NodesPage = lazy(() => import('@/pages/NodesPage').then((m) => ({ default: m.NodesPage })))
const RoutingPage = lazy(() => import('@/pages/RoutingPage').then((m) => ({ default: m.RoutingPage })))
const RequestCostPage = lazy(() => import('@/pages/request-cost-page').then((m) => ({ default: m.RequestCostPage })))
const RecoveryPage = lazy(() => import('@/pages/recovery-page').then((m) => ({ default: m.RecoveryPage })))
const GroupDispositionPage = lazy(() => import('@/pages/group-disposition-page').then((m) => ({ default: m.GroupDispositionPage })))
const OutcomeDispositionPage = lazy(() => import('@/pages/outcome-disposition-page').then((m) => ({ default: m.OutcomeDispositionPage })))
const AttemptCorrectionPage = lazy(() => import('@/pages/attempt-correction-page').then((m) => ({ default: m.AttemptCorrectionPage })))
const UsageRecoveryPage = lazy(() => import('@/pages/usage-recovery-page').then((m) => ({ default: m.UsageRecoveryPage })))
const MediaDispositionPage = lazy(() => import('@/pages/media-disposition-page').then(m => ({default:m.MediaDispositionPage})))
const CostReportPage = lazy(() => import('@/pages/cost-report-page').then(m => ({default:m.CostReportPageView})))
const AdmissionPreviewPage = lazy(() => import('@/pages/admission-preview-page').then(m => ({default:m.AdmissionPreviewPage})))
const MediaTasksPage = lazy(() => import('@/pages/media-tasks-page').then(m => ({default:m.MediaTasksPage})))
const MediaTaskPage = lazy(() => import('@/pages/media-task-page').then(m => ({default:m.MediaTaskPage})))
const MediaSourcesPage = lazy(() => import('@/pages/media-sources-page').then(m => ({default:m.MediaSourcesPage})))
const PricingPage = lazy(() => import('@/pages/pricing-page').then((m) => ({ default: m.PricingPage })))
const BudgetPage = lazy(() => import('@/pages/BudgetPage').then((m) => ({ default: m.BudgetPage })))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))
const ExperimentPage = lazy(() => import('@/pages/ExperimentPage').then((m) => ({ default: m.ExperimentPage })))
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })))
const ShadowPage = lazy(() => import('@/pages/ShadowPage').then((m) => ({ default: m.ShadowPage })))
const RouteExplanationPage = lazy(() => import('@/pages/RouteExplanationPage').then((m) => ({ default: m.RouteExplanationPage })))
const ConfigAuditPage = lazy(() => import('@/pages/ConfigAuditPage').then((m) => ({ default: m.ConfigAuditPage })))
const ManagementAuditPage = lazy(() => import('@/pages/ManagementAuditPage').then((m) => ({ default: m.ManagementAuditPage })))
const BenchmarkPage = lazy(() => import('@/pages/BenchmarkPage').then((m) => ({ default: m.BenchmarkPage })))
const BatchesPage = lazy(() => import('@/pages/BatchesPage').then((m) => ({ default: m.BatchesPage })))
const EvalReportsPage = lazy(() => import('@/pages/EvalReportsPage').then((m) => ({ default: m.EvalReportsPage })))
const ProviderCatalogPage = lazy(() => import('@/pages/ProviderCatalogPage').then((m) => ({ default: m.ProviderCatalogPage })))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage').then((m) => ({ default: m.PlaygroundPage })))
const SessionsPage = lazy(() => import('@/pages/SessionsPage').then((m) => ({ default: m.SessionsPage })))
const McpGatewayPage = lazy(() => import('@/pages/McpGatewayPage').then((m) => ({ default: m.McpGatewayPage })))
const AgentProfilesPage = lazy(() => import('@/pages/AgentProfilesPage').then((m) => ({ default: m.AgentProfilesPage })))
const AgentPlatformPage = lazy(() => import('@/pages/AgentPlatformPage').then((m) => ({ default: m.AgentPlatformPage })))
const CostPlatformPage = lazy(() => import('@/pages/CostPlatformPage').then((m) => ({ default: m.CostPlatformPage })))
const SemanticPlatformPage = lazy(() => import('@/pages/SemanticPlatformPage').then((m) => ({ default: m.SemanticPlatformPage })))
const MembersPage = lazy(() => import('@/pages/MembersPage').then((m) => ({ default: m.MembersPage })))
const WorkspacesPage = lazy(() => import('@/pages/WorkspacesPage').then((m) => ({ default: m.WorkspacesPage })))
const NamespacesPage = lazy(() => import('@/pages/NamespacesPage').then((m) => ({ default: m.NamespacesPage })))

const routeChartBars = [42, 68, 54, 80, 46, 64, 58, 72] as const
const routeListRows = ['w-24', 'w-32', 'w-28', 'w-36'] as const

function RouteFallback() {
  const { t } = useTranslation()
  const loadingLabel = t('status.loading')

  return (
    <section
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={loadingLabel}
      className="min-h-[calc(100vh-9rem)] space-y-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2.5">
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="h-3 w-[min(28rem,80vw)]" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-9" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="min-h-32" />
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="glass-card-static rounded-2xl p-5">
          <div className="mb-6 flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-8 w-20" />
          </div>
          <div className="flex h-56 items-end gap-2 px-2">
            {routeChartBars.map((height, index) => (
              <Skeleton
                key={height}
                className="flex-1 rounded-t-md"
                style={{
                  height: `${height}%`,
                  animationDelay: `${index * 80}ms`,
                }}
              />
            ))}
          </div>
        </div>

        <div className="glass-card-static rounded-2xl p-5">
          <Skeleton className="mb-5 h-4 w-32" />
          <div className="space-y-3">
            {routeListRows.map((width, index) => (
              <div
                key={width}
                className="flex min-h-14 items-center justify-between gap-4 rounded-lg bg-[var(--background-tertiary)] px-3"
              >
                <div className="space-y-2">
                  <Skeleton className={`h-3 ${width}`} />
                  <Skeleton className="h-2.5 w-20" />
                </div>
                <Skeleton
                  className="h-7 w-12 rounded-md"
                  style={{ animationDelay: `${index * 80}ms` }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass-card-static overflow-hidden rounded-2xl">
        <SkeletonTable rows={5} cols={5} />
      </div>
      <span className="sr-only">{loadingLabel}</span>
    </section>
  )
}

function LoginRouteFallback() {
  const { t } = useTranslation()
  const loadingLabel = t('status.loading')

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={loadingLabel}
      className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6"
    >
      <div className="glass-card-static w-full max-w-sm rounded-2xl p-6">
        <div className="mx-auto mb-6 h-11 w-11 animate-shimmer rounded-xl" />
        <div className="space-y-3">
          <Skeleton className="mx-auto h-7 w-36" />
          <Skeleton className="mx-auto h-3 w-56 max-w-full" />
        </div>
        <div className="mt-8 space-y-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
      <span className="sr-only">{loadingLabel}</span>
    </div>
  )
}

function page(element: ReactNode, fallback: ReactNode = <RouteFallback />) {
  return <Suspense fallback={fallback}>{element}</Suspense>
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={page(<LoginPage />, <LoginRouteFallback />)} />
      <Route path="/security" element={<ProtectedRoute>{page(<LoginPage security />, <LoginRouteFallback />)}</ProtectedRoute>} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={page(<DashboardPage />)} />
        <Route path="/launchpad" element={page(<LaunchpadPage />)} />
        <Route path="/updates" element={page(<ReleaseUpdatesPage />)} />
        <Route path="/control-room" element={page(<ControlRoomPage />)} />
        <Route path="/dashboard" element={page(<DashboardPage />)} />
        <Route path="/alerts" element={page(<AlertConnectorsPage />)} />
        <Route path="/logs" element={page(<LogsPage />)} />
        <Route path="/logs/:id/cost" element={page(<RequestCostPage />)} />
        <Route path="/nodes" element={page(<NodesPage />)} />
        <Route path="/catalog" element={page(<ProviderCatalogPage />)} />
        <Route path="/routing" element={page(<RoutingPage />)} />
        <Route path="/pricing" element={page(<PricingPage />)} />
        <Route path="/pricing/cost-report" element={page(<CostReportPage />)} />
        <Route path="/pricing/admission-preview" element={page(<AdmissionPreviewPage />)} />
        <Route path="/pricing/media" element={page(<MediaTasksPage />)} />
        <Route path="/pricing/media/:id" element={page(<MediaTaskPage />)} />
        <Route path="/pricing/media/:id/events/:eventId" element={page(<MediaDispositionPage />)} />
        <Route path="/pricing/media-sources" element={page(<MediaSourcesPage />)} />
        <Route path="/pricing/media-sources/new/register" element={page(<MediaSourcesPage create />)} />
        <Route path="/pricing/media-sources/:id" element={page(<MediaSourcesPage />)} />
        <Route path="/pricing/group-outcomes" element={page(<GroupDispositionPage />)} />
        <Route path="/pricing/group-outcomes/:id" element={page(<GroupDispositionPage />)} />
        <Route path="/pricing/outcomes" element={page(<OutcomeDispositionPage />)} />
        <Route path="/pricing/outcomes/:id" element={page(<OutcomeDispositionPage />)} />
        <Route path="/pricing/recovery" element={page(<RecoveryPage />)} />
        <Route path="/pricing/recovery/:id" element={page(<RecoveryPage />)} />
        <Route path="/pricing/attempts/:id/correction" element={page(<AttemptCorrectionPage />)} />
        <Route path="/pricing/recovery/:id/usage" element={page(<UsageRecoveryPage />)} />
        <Route path="/budget" element={page(<BudgetPage />)} />
        <Route path="/api-keys" element={page(<ApiKeysPage />)} />
        <Route path="/analytics" element={page(<AnalyticsPage />)} />
        <Route path="/experiments" element={page(<ExperimentPage />)} />
        <Route path="/shadow" element={page(<ShadowPage />)} />
        <Route path="/sessions" element={page(<SessionsPage />)} />
        <Route path="/sessions/:sessionId" element={page(<SessionsPage />)} />
        <Route path="/route-decisions" element={page(<RouteExplanationPage />)} />
        <Route path="/route-decisions/:requestId" element={page(<RouteExplanationPage />)} />
        <Route path="/playground" element={page(<PlaygroundPage />)} />
        <Route path="/mcp" element={page(<McpGatewayPage />)} />
        <Route path="/agents" element={page(<AgentProfilesPage />)} />
        <Route path="/agent-platform" element={page(<AgentPlatformPage />)} />
        <Route path="/cost-platform" element={page(<CostPlatformPage />)} />
        <Route path="/semantic-platform" element={page(<SemanticPlatformPage />)} />
        <Route path="/workspaces" element={page(<WorkspacesPage />)} />
        <Route path="/namespaces" element={page(<NamespacesPage />)} />
        <Route path="/members" element={page(<MembersPage />)} />
        <Route path="/audit" element={page(<ManagementAuditPage />)} />
        <Route path="/config-audit" element={page(<ConfigAuditPage />)} />
        <Route path="/benchmarks" element={page(<BenchmarkPage />)} />
        <Route path="/batches" element={page(<BatchesPage />)} />
        <Route path="/evals" element={page(<EvalReportsPage />)} />
        <Route path="/evals/:runId" element={page(<EvalReportsPage />)} />
      </Route>
    </Routes>
  )
}
