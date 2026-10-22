import { Activity, Boxes, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { McpClientConfigCard } from '@/components/mcp/mcp-client-config-card'
import { McpCredentialCard } from '@/components/mcp/mcp-credential-card'
import { McpServerCard } from '@/components/mcp/mcp-server-card'
import { McpToolInspector } from '@/components/mcp/mcp-tool-inspector'
import { McpToolTable, McpToolTableSkeleton } from '@/components/mcp/mcp-tool-table'
import { PieceLogo } from '@/components/connections/piece-logo'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { PieceSummary } from '@/lib/api/types'
import { fallbackMcpServerUrl } from '@/lib/mcp/client-config'
import { mcpErrors } from '@/lib/mcp/mcp-errors'
import { isToolEnabled, MCP_TOOLS, McpToolInfo } from '@/lib/mcp/tool-registry'
import { apiClient } from '@/lib/api/client'
import { useIntegrations, useMcpServerQuery, useUpdateMcpTools } from '@/lib/query/hooks'

type ToolStatusFilter = 'all' | 'enabled' | 'disabled'

const TOOL_FILTER_OPTIONS: Array<{ value: ToolStatusFilter; label: string }> = [
  { value: 'all', label: 'All tools' },
  { value: 'enabled', label: 'Exposed' },
  { value: 'disabled', label: 'Hidden' },
]

function IntegrationCallableRow({ piece }: { piece: PieceSummary }) {
  return (
    <Link
      to={`/integrations/${encodeURIComponent(piece.name)}?tab=actions`}
      className="flex items-center gap-2 rounded-md border border-border bg-card p-2 transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <PieceLogo logoUrl={piece.logoUrl} pieceDisplayName={piece.displayName} className="h-6 w-6" />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
        {piece.displayName}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{piece.actions} actions</span>
    </Link>
  )
}

export default function McpPage() {
  const projectId = apiClient.getProjectId() ?? ''

  const serverQuery = useMcpServerQuery(projectId || undefined)
  const server = serverQuery.data
  const updateMutation = useUpdateMcpTools()
  const integrationsQuery = useIntegrations({ sortBy: 'NAME', orderBy: 'ASC' })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ToolStatusFilter>('all')
  const [pendingTools, setPendingTools] = useState<ReadonlySet<string>>(new Set())
  const [inspectedTool, setInspectedTool] = useState<McpToolInfo | null>(null)
  const [backendServerUrl, setBackendServerUrl] = useState<string | null>(null)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)

  const endpointUrl = backendServerUrl ?? fallbackMcpServerUrl()
  const disabledSet = useMemo(() => new Set(server?.disabledTools ?? []), [server])

  const enabledCount = useMemo(
    () => MCP_TOOLS.filter((tool) => isToolEnabled(tool, disabledSet)).length,
    [disabledSet]
  )

  const filteredTools = useMemo(() => {
    const query = search.trim().toLowerCase()
    return MCP_TOOLS.filter((tool) => {
      if (query) {
        const haystack = `${tool.name} ${tool.displayName} ${tool.description}`.toLowerCase()
        if (!haystack.includes(query)) {
          return false
        }
      }
      const enabled = isToolEnabled(tool, disabledSet)
      if (statusFilter === 'enabled' && !enabled) return false
      if (statusFilter === 'disabled' && enabled) return false
      return true
    })
  }, [search, statusFilter, disabledSet])

  const callableIntegrations = useMemo(
    () => (integrationsQuery.data?.data ?? []).filter((piece) => piece.actions > 0),
    [integrationsQuery.data]
  )

  const toggleTool = (tool: McpToolInfo, nextEnabled: boolean) => {
    const currentDisabled = Array.from(disabledSet)
    const nextDisabled = nextEnabled
      ? currentDisabled.filter((name) => name !== tool.name)
      : [...currentDisabled, tool.name]
    setPendingTools((prev) => new Set(prev).add(tool.name))
    updateMutation.mutate(
      { projectId, request: { disabledTools: nextDisabled } },
      {
        onSuccess: (_data, variables) => {
          const becameEnabled = !(variables.request.disabledTools ?? []).includes(tool.name)
          toast.success(becameEnabled ? 'Tool exposed' : 'Tool hidden', {
            description: `${tool.name} is now ${becameEnabled ? 'visible to' : 'hidden from'} AI agents.`,
          })
        },
        onError: (error) => {
          toast.error('Failed to update tool exposure', {
            description: mcpErrors.describe(error, 'Try again in a moment.'),
          })
        },
        onSettled: () => {
          setPendingTools((prev) => {
            const next = new Set(prev)
            next.delete(tool.name)
            return next
          })
        },
      }
    )
  }

  const isLoading = serverQuery.isPending
  const isError = serverQuery.isError

  return (
    <div className="space-y-6" data-testid="mcp-page">
      <PageHeader
        title="MCP"
        description="Expose your InboxFM Connect tools to AI agents like Claude Desktop, Cursor and Windsurf over the Model Context Protocol."
        breadcrumbs={[{ label: 'Developers', href: '/developers' }, { label: 'MCP' }]}
      />

      {isError ? (
        <ErrorState
          title="Could not load the MCP server"
          description="The MCP configuration for this project could not be loaded. Check your connection and try again."
          onRetry={() => void serverQuery.refetch()}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <McpServerCard
              server={server}
              endpointUrl={endpointUrl}
              enabledToolCount={enabledCount}
              totalToolCount={MCP_TOOLS.length}
            />

            <Card className="border-border shadow-xs">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-bold">Available Tools</CardTitle>
                <CardDescription className="text-xs">
                  Registered on this project&apos;s MCP server. Hidden tools disappear from connected AI clients.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    type="search"
                    icon={<Search className="h-4 w-4" />}
                    placeholder="Search tools..."
                    aria-label="Search MCP tools"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="sm:max-w-xs"
                  />
                  <label htmlFor="mcp-status-filter" className="sr-only">
                    Filter by exposure
                  </label>
                  <select
                    id="mcp-status-filter"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value as ToolStatusFilter)}
                    aria-label="Filter by exposure"
                    className="h-9 cursor-pointer rounded-md border border-input bg-card px-2.5 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    data-testid="mcp-status-filter"
                  >
                    {TOOL_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {!isLoading && (
                    <span className="text-[11px] text-muted-foreground sm:ml-auto" data-testid="mcp-tool-count">
                      {enabledCount} of {MCP_TOOLS.length} exposed
                    </span>
                  )}
                </div>

                {isLoading ? (
                  <McpToolTableSkeleton />
                ) : (
                  <>
                    <McpToolTable
                      tools={filteredTools}
                      disabledTools={disabledSet}
                      pendingTools={pendingTools}
                      onToggle={toggleTool}
                      onSelect={setInspectedTool}
                    />
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
                      <Activity className="h-3 w-3" aria-hidden="true" />
                      <span>
                        Agent tool calls run through the existing runtime and appear in{' '}
                        <Link to="/activity" className="font-medium text-primary underline-offset-2 hover:underline">
                          Activity
                        </Link>
                        .
                      </span>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4 lg:col-span-2">
            <McpCredentialCard
              server={server}
              projectId={projectId}
              onServerUrlDiscovered={setBackendServerUrl}
              onTokenGenerated={setGeneratedToken}
            />

            <McpClientConfigCard serverUrl={endpointUrl} bearerToken={generatedToken ?? undefined} />

            <Card className="border-border shadow-xs">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-bold">
                  <Boxes className="h-4 w-4 text-primary" aria-hidden="true" />
                  <span>Callable Integrations</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  Agents reach every action below through the <code className="font-mono">ap_run_action</code> tool —
                  browse them under{' '}
                  <Link to="/actions" className="font-medium text-primary underline-offset-2 hover:underline">
                    Actions
                  </Link>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent>
                {integrationsQuery.isError ? null : integrationsQuery.isLoading ? (
                  <div className="space-y-2" aria-hidden="true">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton key={index} className="h-11 w-full rounded-md" />
                    ))}
                  </div>
                ) : callableIntegrations.length === 0 ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border bg-card/50 p-3">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      No integrations installed yet.
                    </p>
                    <Button size="xs" variant="outline" asChild>
                      <Link to="/integrations">Browse</Link>
                    </Button>
                  </div>
                ) : (
                  <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1" data-testid="mcp-callable-integrations">
                    {callableIntegrations.map((piece) => (
                      <IntegrationCallableRow key={piece.name} piece={piece} />
                    ))}
                  </div>
                )}
                {serverQuery.isFetching && !isLoading && (
                  <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground" role="status">
                    <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Syncing MCP configuration…
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <McpToolInspector
        tool={inspectedTool}
        enabled={
          inspectedTool === null
            ? null
            : server
              ? isToolEnabled(inspectedTool, new Set(server.disabledTools ?? []))
              : null
        }
        open={inspectedTool !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInspectedTool(null)
          }
        }}
      />
    </div>
  )
}
