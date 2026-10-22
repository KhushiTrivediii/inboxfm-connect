import { ArrowLeft, Play, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { ConnectionPicker } from '@/components/actions/connection-picker'
import { PropertyField } from '@/components/actions/property-field'
import { requiresConnection } from '@/components/integrations/auth-badge'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AutomationStatus,
  CreateTriggerBindingRequest,
  TriggerBinding,
  UpdateTriggerBindingRequest,
} from '@/lib/api/types'
import {
  ActionFormValues,
  initialValuesFromProps,
  serializeValues,
  validateActionValues,
} from '@/lib/utils/action-form'
import { cronUtils } from '@/lib/utils/cron'
import { executionErrors } from '@/lib/utils/execution-errors'
import {
  useConnectionsQuery,
  useCreateTriggerBinding,
  useIntegration,
  useIntegrations,
  useUpdateTriggerBinding,
} from '@/lib/query/hooks'
import { cn } from '@/lib/utils/cn'

export interface TriggerBindingFormProps {
  mode: 'create' | 'edit'
  binding?: TriggerBinding
  defaultPieceName?: string
  defaultTriggerName?: string
}

interface SectionProps {
  index: number
  title: string
  description?: string
  children: React.ReactNode
}

function Section({ index, title, description, children }: SectionProps) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-xs" aria-label={title}>
      <div className="flex items-baseline gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground" aria-hidden="true">
          {index}
        </span>
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="pt-1">{children}</div>
    </section>
  )
}

const selectClass = 'h-9 w-full cursor-pointer rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

export function TriggerBindingForm({ mode, binding, defaultPieceName, defaultTriggerName }: TriggerBindingFormProps) {
  const navigate = useNavigate()
  const createMutation = useCreateTriggerBinding()
  const updateMutation = useUpdateTriggerBinding()

  const [pieceName, setPieceName] = useState(mode === 'edit' ? binding?.pieceName ?? '' : defaultPieceName ?? '')
  const [triggerName, setTriggerName] = useState(mode === 'edit' ? binding?.triggerName ?? '' : defaultTriggerName ?? '')
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    mode === 'edit' ? binding?.connectionId ?? '' : ''
  )
  const [promptTemplate, setPromptTemplate] = useState(mode === 'edit' ? binding?.promptTemplate ?? '' : '')
  const [status, setStatus] = useState<AutomationStatus>(mode === 'edit' ? binding?.status ?? 'ENABLED' : 'ENABLED')
  const [cronExpression, setCronExpression] = useState(() =>
    typeof binding?.settings?.cronExpression === 'string' ? binding.settings.cronExpression : ''
  )
  const [renewCronExpression, setRenewCronExpression] = useState(() =>
    typeof binding?.settings?.renewCronExpression === 'string' ? binding.settings.renewCronExpression : ''
  )
  const [formErrors, setFormErrors] = useState<{ prompt?: string; connection?: string; general?: string }>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const initializedRef = useRef(mode === 'create')
  useEffect(() => {
    if (mode !== 'edit' || !binding || initializedRef.current) {
      return
    }
    initializedRef.current = true
    setPieceName(binding.pieceName)
    setTriggerName(binding.triggerName)
    setSelectedConnectionId(binding.connectionId ?? '')
    setPromptTemplate(binding.promptTemplate)
    setStatus(binding.status)
    setCronExpression(typeof binding.settings?.cronExpression === 'string' ? binding.settings.cronExpression : '')
    setRenewCronExpression(
      typeof binding.settings?.renewCronExpression === 'string' ? binding.settings.renewCronExpression : ''
    )
  }, [mode, binding])

  const integrationsQuery = useIntegrations()
  const allIntegrations = useMemo(
    () => (integrationsQuery.data?.data ?? []).filter((piece) => (piece.triggers ?? 0) > 0),
    [integrationsQuery.data]
  )

  const shouldLoadMetadata = !!pieceName
  const metadataQuery = useIntegration(shouldLoadMetadata ? pieceName : undefined)
  const piece = metadataQuery.data
  const triggers = useMemo(() => Object.values(piece?.triggers ?? {}), [piece])
  const selectedTrigger = triggers.find((trigger) => trigger.name === triggerName) ?? null

  const connectionsQuery = useConnectionsQuery(pieceName ? { pieceName } : undefined)
  const connections = connectionsQuery.data?.data ?? []

  const triggerProps = useMemo(() => selectedTrigger?.props ?? {}, [selectedTrigger])

  const { watch, setValue, reset } = useForm<ActionFormValues>({ defaultValues: {} })
  const values = watch()

  const propsKey = `${pieceName}@${triggerName}`
  const lastPropsKeyRef = useRef('')
  useEffect(() => {
    if (!piece || !triggerName || lastPropsKeyRef.current === propsKey) {
      return
    }
    lastPropsKeyRef.current = propsKey
    reset(initialValuesFromProps(triggerProps))
    if (mode === 'edit' && binding && binding.pieceName === pieceName && binding.triggerName === triggerName) {
      reset({ ...initialValuesFromProps(triggerProps), ...binding.settings })
    }
    setFieldErrors({})
  }, [piece, triggerName, propsKey, triggerProps, reset, mode, binding, pieceName])

  const valuesRef = useRef<ActionFormValues>(values)
  valuesRef.current = values
  const triggerPropsRef = useRef(triggerProps)
  triggerPropsRef.current = triggerProps
  const getInput = useCallback(
    () => serializeValues(triggerPropsRef.current, valuesRef.current),
    []
  )

  const isSubmitting = createMutation.isPending || updateMutation.isPending

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!pieceName || !triggerName || !piece) {
      setFormErrors({
        general: !pieceName
          ? 'Select a source integration.'
          : !triggerName
            ? 'Select a trigger.'
            : 'The integration metadata is still loading.',
      })
      return
    }

    const nextFieldErrors = validateActionValues(triggerProps, values)
    setFieldErrors(nextFieldErrors)

    const cronError = cronExpression.trim() === '' ? undefined : cronUtils.validateCronExpression(cronExpression)
    const renewCronError =
      renewCronExpression.trim() === '' ? undefined : cronUtils.validateCronExpression(renewCronExpression)

    const authRequired = requiresConnection(piece.auth?.type)
    let connectionError: string | undefined
    if (authRequired && !selectedConnectionId) {
      connectionError = 'This trigger requires a connection.'
    }

    let promptError: string | undefined
    if (promptTemplate.trim() === '') {
      promptError = 'An execution instruction is required.'
    }

    setFormErrors({
      connection: connectionError,
      prompt: promptError,
      general: undefined,
    })

    if (
      Object.keys(nextFieldErrors).length > 0 ||
      connectionError ||
      promptError ||
      cronError ||
      renewCronError
    ) {
      toast.error('Fix the highlighted fields before saving.', {
        description: cronError ?? renewCronError,
      })
      return
    }

    const settings: Record<string, unknown> = {
      ...serializeValues(triggerProps, values),
    }
    if (cronExpression.trim() !== '') {
      settings.cronExpression = cronExpression.trim()
    }
    if (renewCronExpression.trim() !== '') {
      settings.renewCronExpression = renewCronExpression.trim()
    }

    try {
      if (mode === 'create') {
        const request: CreateTriggerBindingRequest = {
          pieceName: piece.name,
          pieceVersion: piece.version,
          triggerName,
          connectionId: selectedConnectionId || null,
          promptTemplate: promptTemplate.trim(),
          settings,
          status,
        }
        const created = await createMutation.mutateAsync(request)
        toast.success('Trigger binding created')
        navigate(`/automations/triggers/${created.id}`)
      } else if (binding) {
        const request: UpdateTriggerBindingRequest = {
          pieceName: piece.name,
          pieceVersion: piece.version,
          triggerName,
          connectionId: selectedConnectionId || null,
          promptTemplate: promptTemplate.trim(),
          settings,
          propertySettings: binding.propertySettings,
          status,
        }
        await updateMutation.mutateAsync({ id: binding.id, request })
        toast.success('Trigger binding updated')
        navigate(`/automations/triggers/${binding.id}`)
      }
    } catch (mutationError) {
      setFormErrors({
        general: executionErrors.describe(mutationError, 'The trigger binding could not be saved.'),
      })
    }
  }

  if (integrationsQuery.isError && mode === 'create') {
    return (
      <ErrorState
        title="Unable to load the integration catalog"
        description={executionErrors.describe(integrationsQuery.error, 'Retry in a moment.')}
        onRetry={() => void integrationsQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={mode === 'create' ? 'Create Trigger Binding' : 'Edit Trigger Binding'}
        description="Bind an external event to a headless instruction. When the event fires, HeadlessRuntime executes the configured tools."
        breadcrumbs={[
          { label: 'Automations', href: '/automations/triggers' },
          { label: 'Trigger Bindings', href: '/automations/triggers' },
          { label: mode === 'create' ? 'New' : binding?.id.slice(0, 8) ?? 'Edit' },
        ]}
        actions={
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link to={mode === 'edit' && binding ? `/automations/triggers/${binding.id}` : '/automations/triggers'}>
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back</span>
            </Link>
          </Button>
        }
      />

      <form onSubmit={(event) => void handleSubmit(event)} noValidate className="max-w-3xl space-y-4">
        <Section index={1} title="Source Integration" description="Where the event originates.">
          {integrationsQuery.isLoading ? (
            <Skeleton className="h-9 w-full max-w-md rounded-md" />
          ) : (
            <select
              aria-label="Source integration"
              value={pieceName}
              disabled={isSubmitting}
              onChange={(event) => {
                setPieceName(event.target.value)
                setTriggerName('')
                setSelectedConnectionId('')
                lastPropsKeyRef.current = ''
                setFormErrors({})
              }}
              className={selectClass}
              data-testid="source-integration-select"
            >
              <option value="">Select an integration...</option>
              {allIntegrations.map((integration) => (
                <option key={integration.name} value={integration.name}>
                  {integration.displayName} ({integration.triggers} triggers)
                </option>
              ))}
            </select>
          )}
        </Section>

        <Section index={2} title="Trigger" description="The specific event to react to.">
          {!pieceName ? (
            <p className="text-[11px] text-muted-foreground">Pick an integration first.</p>
          ) : metadataQuery.isLoading ? (
            <Skeleton className="h-9 w-full max-w-md rounded-md" />
          ) : metadataQuery.isError || !piece ? (
            <ErrorState
              title="Unable to load integration metadata"
              onRetry={() => void metadataQuery.refetch()}
            />
          ) : (
            <>
              <select
                aria-label="Trigger"
                value={triggerName}
                disabled={isSubmitting}
                onChange={(event) => {
                  setTriggerName(event.target.value)
                  lastPropsKeyRef.current = ''
                  setFormErrors({})
                }}
                className={selectClass}
                data-testid="trigger-select"
              >
                <option value="">Select a trigger...</option>
                {triggers.map((trigger) => (
                  <option key={trigger.name} value={trigger.name}>
                    {trigger.displayName} ({trigger.type.toLowerCase()})
                  </option>
                ))}
              </select>
              {selectedTrigger && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">{selectedTrigger.description}</p>
              )}
            </>
          )}
        </Section>

        <Section index={3} title="Connection" description="The account this trigger authenticates with. Optional for triggers that need no authentication.">
          {!pieceName ? (
            <p className="text-[11px] text-muted-foreground">Pick an integration first.</p>
          ) : (
            <ConnectionPicker
              pieceName={pieceName}
              pieceDisplayName={piece?.displayName}
              connections={connections}
              isLoading={connectionsQuery.isLoading}
              selectedId={selectedConnectionId}
              onSelect={(id) => {
                setSelectedConnectionId(id)
                setFormErrors((errors) => ({ ...errors, connection: undefined }))
              }}
              error={formErrors.connection}
              disabled={isSubmitting}
            />
          )}
        </Section>

        {selectedTrigger && Object.keys(triggerProps).length > 0 && (
          <Section
            index={4}
            title="Trigger Configuration"
            description="Inputs used by the trigger itself (e.g. which repository or mailbox to watch)."
          >
            <div className="space-y-4">
              {piece &&
                Object.entries(triggerProps).map(([propName, property]) => (
                  <PropertyField
                    key={propName}
                    pieceName={piece.name}
                    pieceVersion={piece.version}
                    actionOrTriggerName={triggerName}
                    name={propName}
                    property={property}
                    value={values[propName]}
                    onChange={(nextValue) => setValue(propName, nextValue, { shouldDirty: true })}
                    getInput={getInput}
                    error={fieldErrors[propName]}
                    disabled={isSubmitting}
                  />
                ))}
            </div>
          </Section>
        )}

        <Section
          index={5}
          title="Execution Instruction"
          description="Plain-text instructions executed by HeadlessRuntime when the event fires. Describe what should happen — which tools to call and why."
        >
          <label htmlFor="binding-prompt" className="sr-only">
            Execution instruction
          </label>
          <textarea
            id="binding-prompt"
            rows={4}
            value={promptTemplate}
            disabled={isSubmitting}
            onChange={(event) => {
              setPromptTemplate(event.target.value)
              setFormErrors((errors) => ({ ...errors, prompt: undefined }))
            }}
            placeholder={'When a new issue is created, summarize it and post the summary to the engineering Slack channel.'}
            aria-invalid={!!formErrors.prompt || undefined}
            aria-describedby={formErrors.prompt ? 'binding-prompt-error' : undefined}
            className={cn(
              'w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-xs shadow-xs transition-colors placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
              formErrors.prompt && 'border-destructive'
            )}
            data-testid="prompt-template-input"
          />
          {formErrors.prompt && (
            <p id="binding-prompt-error" role="alert" className="text-[11px] font-medium text-destructive">
              {formErrors.prompt}
            </p>
          )}
        </Section>

        <Section
          index={6}
          title="Advanced Scheduling"
          description="Optional. Polling bindings can run periodically; webhook bindings can renew provider subscriptions. Leave empty unless required."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="binding-cron" className="text-xs font-medium text-foreground">
                Run cron
              </label>
              <Input
                id="binding-cron"
                type="text"
                spellCheck={false}
                value={cronExpression}
                disabled={isSubmitting}
                onChange={(event) => setCronExpression(event.target.value)}
                placeholder="*/15 * * * *"
                className="font-mono text-xs"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {cronExpression.trim() === ''
                  ? 'Not scheduled.'
                  : cronUtils.describeCronExpression(cronExpression) ?? 'Invalid cron expression.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="binding-renew-cron" className="text-xs font-medium text-foreground">
                Renewal cron
              </label>
              <Input
                id="binding-renew-cron"
                type="text"
                spellCheck={false}
                value={renewCronExpression}
                disabled={isSubmitting}
                onChange={(event) => setRenewCronExpression(event.target.value)}
                placeholder="0 0 * * 1"
                className="font-mono text-xs"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {renewCronExpression.trim() === ''
                  ? 'Not scheduled.'
                  : cronUtils.describeCronExpression(renewCronExpression) ?? 'Invalid cron expression.'}
              </p>
            </div>
          </div>
        </Section>

        <Section index={7} title="Status" description="Disabled bindings ignore incoming events.">
          <div className="inline-flex overflow-hidden rounded-lg border border-border" role="group" aria-label="Binding status">
            {(['ENABLED', 'DISABLED'] as AutomationStatus[]).map((option) => (
              <button
                key={option}
                type="button"
                disabled={isSubmitting}
                aria-pressed={status === option}
                onClick={() => setStatus(option)}
                data-testid={`status-${option.toLowerCase()}`}
                className={cn(
                  'px-4 py-1.5 text-xs font-semibold transition-colors cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                  status === option
                    ? option === 'ENABLED'
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-foreground'
                    : 'bg-card text-muted-foreground hover:text-foreground'
                )}
              >
                {option === 'ENABLED' ? 'Enabled' : 'Disabled'}
              </button>
            ))}
          </div>
        </Section>

        {formErrors.general && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive" data-testid="form-general-error">
            {formErrors.general}
          </p>
        )}

        <div className="flex items-center gap-2 border-t border-border pt-4">
          <Button
            type="submit"
            size="sm"
            loading={isSubmitting}
            disabled={!pieceName || !triggerName || isSubmitting}
            className="gap-1.5 font-semibold"
            data-testid="submit-binding"
          >
            {!isSubmitting && (mode === 'create' ? <Zap className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />)}
            <span>{mode === 'create' ? 'Create Binding' : 'Save Changes'}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSubmitting}
            onClick={() =>
              navigate(mode === 'edit' && binding ? `/automations/triggers/${binding.id}` : '/automations/triggers')
            }
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
