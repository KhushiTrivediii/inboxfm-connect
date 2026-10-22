import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './components/layout/app-shell'
import { RequireAuth } from './components/layout/require-auth'
import { setAuthNavigator } from './lib/auth/auth-navigation'
import { LoadingState } from './components/ui/loading-state'

const DashboardPage = lazy(() => import('./pages/dashboard'))
const IntegrationsPage = lazy(() => import('./pages/integrations'))
const IntegrationDetailPage = lazy(() => import('./pages/integrations/detail'))
const ConnectionsPage = lazy(() => import('./pages/connections'))
const NewConnectionPage = lazy(() => import('./pages/connections/new'))
const ConnectionDetailPage = lazy(() => import('./pages/connections/detail'))
const ActionsPage = lazy(() => import('./pages/actions'))
const ActionDetailPage = lazy(() => import('./pages/actions/detail'))
const TriggersPage = lazy(() => import('./pages/triggers'))
const TriggerBindingsPage = lazy(() => import('./pages/automations/triggers'))
const NewTriggerBindingPage = lazy(() => import('./pages/automations/triggers-new'))
const TriggerBindingDetailPage = lazy(() => import('./pages/automations/triggers-detail'))
const EditTriggerBindingPage = lazy(() => import('./pages/automations/triggers-edit'))
const ScheduledTasksPage = lazy(() => import('./pages/automations/schedules'))
const NewScheduledTaskPage = lazy(() => import('./pages/automations/schedules-new'))
const ScheduledTaskDetailPage = lazy(() => import('./pages/automations/schedules-detail'))
const EditScheduledTaskPage = lazy(() => import('./pages/automations/schedules-edit'))
const ApiKeysPage = lazy(() => import('./pages/api-keys'))
const McpPage = lazy(() => import('./pages/mcp'))
const ActivityPage = lazy(() => import('./pages/activity'))
const ExecutionDetailPage = lazy(() => import('./pages/activity/detail'))
const DevelopersPage = lazy(() => import('./pages/developers'))
const SettingsPage = lazy(() => import('./pages/settings'))
const LoginPage = lazy(() => import('./pages/auth/login'))
const ConnectPage = lazy(() => import('./pages/connect'))
const WelcomePage = lazy(() => import('./pages/welcome'))
const NotFoundPage = lazy(() => import('./pages/not-found'))

const withSuspense = (Component: React.ComponentType) => (
  <Suspense fallback={<LoadingState rows={4} />}>
    <Component />
  </Suspense>
)

export const router = createBrowserRouter([
  {
    path: '/welcome',
    element: withSuspense(WelcomePage),
  },
  {
    path: '/login',
    element: withSuspense(LoginPage),
  },
  {
    path: '/connect/:token',
    element: withSuspense(ConnectPage),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        element: withSuspense(DashboardPage),
      },
      {
        path: 'integrations',
        element: withSuspense(IntegrationsPage),
      },
      {
        path: 'integrations/:name',
        element: withSuspense(IntegrationDetailPage),
      },
      {
        path: 'connections',
        element: withSuspense(ConnectionsPage),
      },
      {
        path: 'connections/new',
        element: withSuspense(NewConnectionPage),
      },
      {
        path: 'connections/:id',
        element: withSuspense(ConnectionDetailPage),
      },
      {
        path: 'actions',
        element: withSuspense(ActionsPage),
      },
      {
        path: 'actions/:pieceName/:actionName',
        element: withSuspense(ActionDetailPage),
      },
      {
        path: 'triggers',
        element: withSuspense(TriggersPage),
      },
      {
        path: 'automations/triggers',
        element: withSuspense(TriggerBindingsPage),
      },
      {
        path: 'automations/triggers/new',
        element: withSuspense(NewTriggerBindingPage),
      },
      {
        path: 'automations/triggers/:id',
        element: withSuspense(TriggerBindingDetailPage),
      },
      {
        path: 'automations/triggers/:id/edit',
        element: withSuspense(EditTriggerBindingPage),
      },
      {
        path: 'automations/schedules',
        element: withSuspense(ScheduledTasksPage),
      },
      {
        path: 'automations/schedules/new',
        element: withSuspense(NewScheduledTaskPage),
      },
      {
        path: 'automations/schedules/:id',
        element: withSuspense(ScheduledTaskDetailPage),
      },
      {
        path: 'automations/schedules/:id/edit',
        element: withSuspense(EditScheduledTaskPage),
      },
      {
        path: 'mcp',
        element: withSuspense(McpPage),
      },
      {
        path: 'activity',
        element: withSuspense(ActivityPage),
      },
      {
        path: 'activity/:id',
        element: withSuspense(ExecutionDetailPage),
      },
      {
        path: 'developers',
        element: withSuspense(DevelopersPage),
      },
      {
        path: 'api-keys',
        element: withSuspense(ApiKeysPage),
      },
      {
        path: 'settings',
        element: withSuspense(SettingsPage),
      },
      {
        path: '404',
        element: withSuspense(NotFoundPage),
      },
      {
        path: '*',
        element: <Navigate to="/404" replace />,
      },
    ],
  },
])

setAuthNavigator((to, opts) => {
  void router.navigate(to, opts)
})

