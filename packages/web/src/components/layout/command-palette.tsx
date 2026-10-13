import {
  Activity,
  Blocks,
  Bot,
  CalendarClock,
  Code2,
  KeyRound,
  LayoutGrid,
  Loader2,
  Radio,
  Settings,
  Zap,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandSeparator,
} from '@/components/ui/command'
import {
  useConnectionsInfiniteQuery,
  useExecutionsQuery,
  useIntegrations,
  useScheduledTasksInfiniteQuery,
  useTriggerBindingsInfiniteQuery,
} from '@/lib/query/hooks'

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const {
    data: connectionsPages,
    hasNextPage: hasNextConnections,
    isFetchingNextPage: isFetchingNextConnections,
    fetchNextPage: fetchNextConnections,
    isLoading: isLoadingConnections,
  } = useConnectionsInfiniteQuery(
    { limit: 100 },
    { enabled: open, showErrorToast: false }
  )

  const {
    data: triggerBindingsPages,
    hasNextPage: hasNextTriggers,
    isFetchingNextPage: isFetchingNextTriggers,
    fetchNextPage: fetchNextTriggers,
    isLoading: isLoadingTriggers,
  } = useTriggerBindingsInfiniteQuery({
    enabled: open,
    showErrorToast: false,
  })

  const {
    data: scheduledTasksPages,
    hasNextPage: hasNextSchedules,
    isFetchingNextPage: isFetchingNextSchedules,
    fetchNextPage: fetchNextSchedules,
    isLoading: isLoadingSchedules,
  } = useScheduledTasksInfiniteQuery({
    enabled: open,
    showErrorToast: false,
  })

  const {
    data: executionsData,
    isLoading: isLoadingExecutions,
  } = useExecutionsQuery(
    { limit: 50 },
    { enabled: open, showErrorToast: false }
  )

  const {
    data: integrationsData,
    isLoading: isLoadingIntegrations,
  } = useIntegrations(
    undefined,
    { enabled: open, showErrorToast: false }
  )

  // Follow SeekPage.next for all paginated resources while the palette is open
  React.useEffect(() => {
    if (open && hasNextConnections && !isFetchingNextConnections) {
      void fetchNextConnections()
    }
  }, [open, hasNextConnections, isFetchingNextConnections, fetchNextConnections])

  React.useEffect(() => {
    if (open && hasNextTriggers && !isFetchingNextTriggers) {
      void fetchNextTriggers()
    }
  }, [open, hasNextTriggers, isFetchingNextTriggers, fetchNextTriggers])

  React.useEffect(() => {
    if (open && hasNextSchedules && !isFetchingNextSchedules) {
      void fetchNextSchedules()
    }
  }, [open, hasNextSchedules, isFetchingNextSchedules, fetchNextSchedules])

  const connections = React.useMemo(
    () => connectionsPages?.pages.flatMap((page) => page.data) ?? [],
    [connectionsPages]
  )
  const triggerBindings = React.useMemo(
    () => triggerBindingsPages?.pages.flatMap((page) => page.data) ?? [],
    [triggerBindingsPages]
  )
  const scheduledTasks = React.useMemo(
    () => scheduledTasksPages?.pages.flatMap((page) => page.data) ?? [],
    [scheduledTasksPages]
  )
  const executions = executionsData?.data
  const integrations = integrationsData?.data

  const isInitialLoading =
    open &&
    (isLoadingConnections ||
      isLoadingTriggers ||
      isLoadingSchedules ||
      isLoadingExecutions ||
      isLoadingIntegrations)

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, onOpenChange])

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      onOpenChange(false)
      command()
    },
    [onOpenChange]
  )

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('Search resources, integrations, routes...')} />
      <CommandList>
        {isInitialLoading && (
          <CommandLoading>
            <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('Loading resources...')}</span>
            </div>
          </CommandLoading>
        )}
        <CommandEmpty>{t('No results found.')}</CommandEmpty>

        {connections && connections.length > 0 && (
          <CommandGroup heading={t('Connections')}>
            {connections.map((c) => (
              <CommandItem
                key={`conn-${c.id}`}
                value={`${c.displayName} ${c.pieceName} ${c.status} ${c.id}`}
                keywords={[c.displayName, c.pieceName, c.status, c.id]}
                onSelect={() => runCommand(() => navigate(`/connections/${c.id}`))}
                className="cursor-pointer"
              >
                <KeyRound className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center justify-between overflow-hidden">
                  <span className="truncate font-medium">{c.displayName}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">{c.pieceName}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {triggerBindings && triggerBindings.length > 0 && (
          <CommandGroup heading={t('Trigger Bindings')}>
            {triggerBindings.map((b) => (
              <CommandItem
                key={`trigger-${b.id}`}
                value={`${b.triggerName} ${b.pieceName} ${b.promptTemplate || ''} ${b.id}`}
                keywords={[b.triggerName, b.pieceName, b.status, b.id, b.promptTemplate || '']}
                onSelect={() => runCommand(() => navigate(`/automations/triggers/${b.id}`))}
                className="cursor-pointer"
              >
                <Radio className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center justify-between overflow-hidden">
                  <span className="truncate font-medium">{b.triggerName}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">{b.pieceName}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {scheduledTasks && scheduledTasks.length > 0 && (
          <CommandGroup heading={t('Scheduled Tasks')}>
            {scheduledTasks.map((s) => (
              <CommandItem
                key={`sched-${s.id}`}
                value={`${s.prompt} ${s.cronExpression} ${s.timezone} ${s.id}`}
                keywords={[s.prompt, s.cronExpression, s.timezone, s.status, s.id]}
                onSelect={() => runCommand(() => navigate(`/automations/schedules/${s.id}`))}
                className="cursor-pointer"
              >
                <CalendarClock className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center justify-between overflow-hidden">
                  <span className="truncate font-medium">{s.prompt}</span>
                  <span className="ml-2 shrink-0 font-mono text-xs text-muted-foreground">
                    {s.cronExpression}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {executions && executions.length > 0 && (
          <CommandGroup heading={t('Recent Executions')}>
            {executions.map((e) => (
              <CommandItem
                key={`exec-${e.id}`}
                value={`${e.prompt || `Execution ${e.id}`} ${e.status} ${e.id}`}
                keywords={[e.prompt || '', e.status, e.id]}
                onSelect={() => runCommand(() => navigate(`/activity/${e.id}`))}
                className="cursor-pointer"
              >
                <Activity className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center justify-between overflow-hidden">
                  <span className="truncate font-medium">
                    {e.prompt || t('Execution {{id}}...', { id: e.id.slice(0, 8) })}
                  </span>
                  <span className="ml-2 shrink-0 text-xs capitalize text-muted-foreground">
                    {e.status.toLowerCase()}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {integrations && integrations.length > 0 && (
          <CommandGroup heading={t('Integrations')}>
            {integrations.map((p) => (
              <CommandItem
                key={`integ-${p.name}`}
                value={`${p.displayName} ${p.name} ${p.description || ''}`}
                keywords={[p.displayName, p.name, ...(p.categories || [])]}
                onSelect={() =>
                  runCommand(() => navigate(`/integrations/${encodeURIComponent(p.name)}`))
                }
                className="cursor-pointer"
              >
                <Blocks className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-1 items-center justify-between overflow-hidden">
                  <span className="truncate font-medium">{p.displayName}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">v{p.version}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading={t('Navigation')}>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/'))}
            className="cursor-pointer"
          >
            <LayoutGrid className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Overview Dashboard')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/integrations'))}
            className="cursor-pointer"
          >
            <Blocks className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Integrations Catalog')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/connections'))}
            className="cursor-pointer"
          >
            <KeyRound className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Connections & Credentials')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/actions'))}
            className="cursor-pointer"
          >
            <Zap className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Actions & Tool Discovery')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/triggers'))}
            className="cursor-pointer"
          >
            <Radio className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Triggers & Event Capabilities')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/automations/triggers'))}
            className="cursor-pointer"
          >
            <Radio className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Trigger Bindings')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/automations/schedules'))}
            className="cursor-pointer"
          >
            <CalendarClock className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Scheduled Tasks')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/mcp'))}
            className="cursor-pointer"
          >
            <Bot className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('MCP Server & Tools')}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('Monitoring & Platform')}>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/activity'))}
            className="cursor-pointer"
          >
            <Activity className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Activity & Execution Logs')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/developers'))}
            className="cursor-pointer"
          >
            <Code2 className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Developer SDK & API Reference')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runCommand(() => navigate('/settings'))}
            className="cursor-pointer"
          >
            <Settings className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>{t('Project Settings')}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
