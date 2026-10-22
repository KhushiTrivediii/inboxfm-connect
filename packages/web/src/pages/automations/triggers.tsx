import { Plus, RadioTower } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AutomationDeleteDialog,
} from '@/components/automations/automation-delete-dialog'
import { TriggerBindingTable } from '@/components/automations/trigger-binding-table'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { AppConnection, PieceSummary, TriggerBinding } from '@/lib/api/types'
import { executionErrors } from '@/lib/utils/execution-errors'
import {
  useConnectionsQuery,
  useDeleteTriggerBinding,
  useDisableTriggerBinding,
  useEnableTriggerBinding,
  useIntegrations,
  useTriggerBindingsQuery,
} from '@/lib/query/hooks'

export default function TriggerBindingsPage() {
  const navigate = useNavigate()
  const bindingsQuery = useTriggerBindingsQuery()
  const integrationsQuery = useIntegrations()
  const connectionsQuery = useConnectionsQuery()

  const enableMutation = useEnableTriggerBinding()
  const disableMutation = useDisableTriggerBinding()
  const deleteMutation = useDeleteTriggerBinding()
  const [deleteTarget, setDeleteTarget] = useState<TriggerBinding | null>(null)

  const bindings = bindingsQuery.data ?? []

  const connectionsById = useMemo(() => {
    const map: Record<string, AppConnection> = {}
    for (const connection of connectionsQuery.data?.data ?? []) {
      map[connection.id] = connection
    }
    return map
  }, [connectionsQuery.data])

  const integrationsByName = useMemo(() => {
    const map: Record<string, PieceSummary> = {}
    for (const piece of integrationsQuery.data?.data ?? []) {
      map[piece.name] = piece
    }
    return map
  }, [integrationsQuery.data])

  const pendingStatusChangeId =
    enableMutation.isPending || disableMutation.isPending
      ? enableMutation.variables?.id ?? disableMutation.variables?.id ?? null
      : null

  async function handleToggleStatus(binding: TriggerBinding) {
    try {
      if (binding.status === 'ENABLED') {
        await disableMutation.mutateAsync({ id: binding.id })
        toast.success('Trigger binding disabled', {
          description: 'Incoming events will no longer invoke this binding.',
        })
      } else {
        await enableMutation.mutateAsync({ id: binding.id })
        toast.success('Trigger binding enabled')
      }
    } catch (mutationError) {
      toast.error('Could not change the binding status', {
        description: executionErrors.describe(mutationError, 'Try again in a moment.'),
      })
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id })
      toast.success('Trigger binding deleted')
      setDeleteTarget(null)
    } catch (mutationError) {
      toast.error('Failed to delete trigger binding', {
        description: executionErrors.describe(mutationError, 'The binding could not be deleted.'),
      })
    }
  }

  if (bindingsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <HubHeader />
        <div className="space-y-2" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (bindingsQuery.isError) {
    return (
      <div className="space-y-6">
        <HubHeader />
        <ErrorState
          title="Unable to load trigger bindings"
          description={executionErrors.describe(
            bindingsQuery.error,
            'The automation layer could not be reached. Retry shortly.'
          )}
          onRetry={() => void bindingsQuery.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <HubHeader />

      {bindings.length === 0 ? (
        <EmptyState
          icon={RadioTower}
          title="No trigger bindings configured"
          description="Browse event sources and bind one to an executable instruction — GitHub issues, Gmail messages, Stripe payments and more."
          actionLabel="Browse Triggers"
          actionIcon={Plus}
          onAction={() => navigate('/triggers')}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {bindings.length} binding{bindings.length === 1 ? '' : 's'} configured
          </p>
          <TriggerBindingTable
            bindings={bindings}
            connectionsById={connectionsById}
            integrationsByName={integrationsByName}
            pendingStatusChangeId={pendingStatusChangeId}
            onToggleStatus={(binding) => void handleToggleStatus(binding)}
            onRequestDelete={setDeleteTarget}
          />
        </>
      )}

      <AutomationDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        kind="trigger-binding"
        label={deleteTarget ? `${deleteTarget.pieceName} / ${deleteTarget.triggerName}` : ''}
        loading={deleteMutation.isPending}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

function HubHeader() {
  return (
    <PageHeader
      title="Trigger Bindings"
      description="Event-driven integrations that execute instructions automatically when external events fire."
      actions={
        <Button size="sm" asChild className="gap-1.5 shadow-xs" data-testid="create-binding-button">
          <Link to="/automations/triggers/new">
            <Plus className="h-3.5 w-3.5" />
            <span>Create Trigger Binding</span>
          </Link>
        </Button>
      }
    />
  )
}
