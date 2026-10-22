import {
  Activity,
  ArrowUpRight,
  Blocks,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  Plus,
  Radio,
  XCircle,
  Zap,
} from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth/auth-context'
import {
  useConnectionsQuery,
  useExecutionsQuery,
  useIntegrations,
  useScheduledTasksQuery,
  useTriggerBindingsQuery,
} from '@/lib/query/hooks'

export default function DashboardPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const {
    data: integrationsData,
    isLoading: isIntegrationsLoading,
    isError: isIntegrationsError,
    refetch: refetchIntegrations,
  } = useIntegrations()
  const {
    data: connections,
    isLoading: isConnectionsLoading,
    isError: isConnectionsError,
    refetch: refetchConnections,
  } = useConnectionsQuery()
  const {
    data: triggerBindings,
    isLoading: isTriggersLoading,
    isError: isTriggersError,
    refetch: refetchTriggers,
  } = useTriggerBindingsQuery()
  const {
    data: scheduledTasks,
    isLoading: isSchedulesLoading,
    isError: isSchedulesError,
    refetch: refetchSchedules,
  } = useScheduledTasksQuery()
  const {
    data: executionsData,
    isLoading: isExecutionsLoading,
    isError: isExecutionsError,
    refetch: refetchExecutions,
  } = useExecutionsQuery({ limit: 5 })

  const connectionList = connections?.data || []
  const executions = executionsData?.data || []
  const integrationList = integrationsData?.data || []

  // Count available tools across integrations
  const totalToolsCount = integrationList.reduce((acc, piece) => acc + (piece.actions || 0), 0)
  const activeConnectionsCount = connectionList.filter((c) => c.status === 'ACTIVE').length
  const activeTriggersCount = triggerBindings?.filter((t) => t.status === 'ENABLED').length || 0
  const activeSchedulesCount = scheduledTasks?.filter((s) => s.status === 'ENABLED').length || 0

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back${user?.firstName ? `, ${user.firstName}` : ''}`}
        description="Connect your apps, discover callable tools, and expose them to your software or AI agents."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" asChild className="gap-1.5 shadow-xs">
              <Link to="/integrations">
                <Plus className="h-3.5 w-3.5" />
                <span>Connect Integration</span>
              </Link>
            </Button>
          </div>
        }
      />

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Metric 1: Available Tools */}
        <Card className="p-4 border-border/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Available Tools</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Zap className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2">
            {isIntegrationsLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : isIntegrationsError ? (
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-destructive font-medium">Failed to load</span>
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="retry-button"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void refetchIntegrations()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {totalToolsCount}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Across {integrationList.length} integrations
                </p>
              </>
            )}
          </div>
        </Card>

        {/* Metric 2: Active Connections */}
        <Card className="p-4 border-border/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Active Connections</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <KeyRound className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2">
            {isConnectionsLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : isConnectionsError ? (
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-destructive font-medium">Failed to load</span>
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="retry-button"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void refetchConnections()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {activeConnectionsCount}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {connectionList.length} total credentials
                </p>
              </>
            )}
          </div>
        </Card>

        {/* Metric 3: Trigger Bindings */}
        <Card className="p-4 border-border/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Trigger Bindings</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Radio className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2">
            {isTriggersLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : isTriggersError ? (
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-destructive font-medium">Failed to load</span>
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="retry-button"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void refetchTriggers()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {activeTriggersCount}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {triggerBindings?.length || 0} configured event listeners
                </p>
              </>
            )}
          </div>
        </Card>

        {/* Metric 4: Scheduled Tasks */}
        <Card className="p-4 border-border/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Scheduled Tasks</span>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400">
              <CalendarClock className="h-3.5 w-3.5" />
            </div>
          </div>
          <div className="mt-2">
            {isSchedulesLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : isSchedulesError ? (
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-destructive font-medium">Failed to load</span>
                <Button
                  variant="ghost"
                  size="xs"
                  data-testid="retry-button"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void refetchSchedules()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  {activeSchedulesCount}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {scheduledTasks?.length || 0} cron schedules
                </p>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Quick Action Cards */}
      <div className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Developer Quick Actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Link
            to="/integrations"
            className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 hover:bg-muted/40 transition-all shadow-xs"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Blocks className="h-4 w-4 text-primary" />
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-foreground">Explore Integrations</h3>
              <p className="text-[11px] text-muted-foreground">
                Discover 400+ third-party tools & connect accounts.
              </p>
            </div>
          </Link>

          <Link
            to="/actions"
            className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 hover:bg-muted/40 transition-all shadow-xs"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Zap className="h-4 w-4 text-amber-500" />
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-amber-500 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-foreground">Test & Execute Tools</h3>
              <p className="text-[11px] text-muted-foreground">
                Directly run any tool with schema inputs on HeadlessRuntime.
              </p>
            </div>
          </Link>

          <Link
            to="/automations/triggers"
            className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 hover:bg-muted/40 transition-all shadow-xs"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Radio className="h-4 w-4 text-emerald-500" />
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-emerald-500 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-foreground">Trigger Bindings</h3>
              <p className="text-[11px] text-muted-foreground">
                Bind webhooks and polling events directly to target tools.
              </p>
            </div>
          </Link>

          <Link
            to="/mcp"
            className="group flex flex-col justify-between rounded-lg border border-border bg-card p-4 hover:border-primary/50 hover:bg-muted/40 transition-all shadow-xs"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Bot className="h-4 w-4 text-purple-500" />
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-purple-500 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-foreground">Model Context Protocol</h3>
              <p className="text-[11px] text-muted-foreground">
                Expose your connected tools to Claude, Cursor & Windsurf.
              </p>
            </div>
          </Link>
        </div>
      </div>

      {/* Recent Activity Table */}
      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-sm font-bold">Recent Executions</CardTitle>
            <CardDescription className="text-xs">
              Live audit logs from Direct Executions, Trigger Bindings, and Scheduled Tasks.
            </CardDescription>
          </div>
          <Button variant="outline" size="xs" asChild className="gap-1 text-xs">
            <Link to="/activity">
              <span>View all</span>
              <ExternalLink className="h-3 w-3" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {isExecutionsLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isExecutionsError ? (
            <div className="p-8">
              <ErrorState
                title="Unable to load recent executions"
                description="The execution log could not be reached. Retry shortly."
                onRetry={() => void refetchExecutions()}
              />
            </div>
          ) : executions.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={Activity}
                title="No executions recorded yet"
                description="When you test a tool, fire a trigger binding, or run a scheduled task, execution logs will appear here."
                actionLabel="Explore Tools to Test"
                onAction={() => navigate('/actions')}
              />
            </div>
          ) : (
            <div className="divide-y divide-border text-xs">
              {executions.map((exec) => (
                <div
                  key={exec.id}
                  className="flex items-center justify-between p-3.5 px-5 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {exec.status === 'COMPLETED' ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                    ) : exec.status === 'FAILED' ? (
                      <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    ) : (
                      <Clock className="h-4 w-4 text-amber-500 animate-spin shrink-0" />
                    )}
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground truncate max-w-md">
                        {exec.prompt || 'Direct Execution'}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        ID: {exec.id} • {new Date(exec.created).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Badge
                      variant={
                        exec.status === 'COMPLETED'
                          ? 'success'
                          : exec.status === 'FAILED'
                          ? 'destructive'
                          : 'outline'
                      }
                      className="text-[10px]"
                    >
                      {exec.status}
                    </Badge>
                    <Link
                      to={`/activity/${exec.id}`}
                      className="text-xs text-muted-foreground hover:text-foreground font-medium"
                    >
                      Inspect
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
