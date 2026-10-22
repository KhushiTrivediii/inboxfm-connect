import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@inboxfm-connect/shared'
import { type AIProviderName, aiProvidersApi } from '../api/ai-providers'
import { apiKeysApi } from '../api/api-keys'
import { automationsApi } from '../api/automations'
import { billingApi } from '../api/billing'
import { apiClient } from '../api/client'
import { connectionsApi } from '../api/connections'
import { executeApi } from '../api/execute'
import { executionsApi } from '../api/executions'
import { platformApi } from '../api/platform'
import { platformApiKeysApi } from '../api/platform-api-keys'
import {
  ConnectionsListParams,
  CreateConnectionRequest,
  CreateScheduledTaskRequest,
  CreateTriggerBindingRequest,
  DropdownState,
  ExecuteRequest,
  ExecuteResponse,
  Execution,
  ExecutionStatus,
  GenerateMcpTokenResponse,
  IntegrationOptionsRequest,
  IntegrationsListParams,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  OAuth2AuthorizationUrlRequest,
  PieceMetadata,
  PieceSummary,
  PopulatedMcpServer,
  ScheduledTask,
  SeekPage,
  TriggerBinding,
  UpdateMcpServerRequest,
  UpdateScheduledTaskRequest,
  UpdateTriggerBindingRequest,
} from '../api/types'

export function useIntegrations(
  params?: IntegrationsListParams,
  options?: { enabled?: boolean; showErrorToast?: boolean }
) {
  const showErrorToast = options?.showErrorToast ?? false
  return useQuery({
    queryKey: ['integrations', params ?? {}],
    queryFn: () => apiClient.get<SeekPage<PieceSummary>>('/integrations', { params }),
    placeholderData: keepPreviousData,
    enabled: options?.enabled,
    meta: { showErrorToast },
  })
}

export function useIntegrationCategories() {
  return useQuery({
    queryKey: ['integration-categories'],
    queryFn: () => apiClient.get<string[]>('/integrations/categories'),
    staleTime: Infinity,
  })
}

export function useIntegration(name?: string) {
  return useQuery({
    queryKey: ['integration', name],
    queryFn: () => apiClient.get<PieceMetadata>(`/integrations/${encodeURIComponent(name ?? '')}`),
    enabled: !!name,
  })
}

export function useConnectionsQuery(
  params?: ConnectionsListParams,
  options?: { keepPreviousData?: boolean; enabled?: boolean; showErrorToast?: boolean }
) {
  const projectId = apiClient.getProjectId()
  const showErrorToast = options?.showErrorToast ?? true
  return useQuery({
    queryKey: ['connections', params ?? {}, projectId],
    queryFn: () => connectionsApi.list(params),
    placeholderData: options?.keepPreviousData ? keepPreviousData : undefined,
    meta: { showErrorToast, showErrorDialog: showErrorToast },
    enabled: options?.enabled,
  })
}

export function useConnectionsInfiniteQuery(
  params?: Omit<ConnectionsListParams, 'cursor'>,
  options?: { enabled?: boolean; showErrorToast?: boolean }
) {
  const projectId = apiClient.getProjectId()
  const showErrorToast = options?.showErrorToast ?? true
  return useInfiniteQuery({
    queryKey: ['connections', 'infinite', params ?? {}, projectId],
    queryFn: ({ pageParam }) =>
      connectionsApi.list({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    meta: { showErrorToast, showErrorDialog: showErrorToast },
    enabled: options?.enabled,
  })
}

export function useConnection(id?: string) {
  return useQuery({
    queryKey: ['connection', id],
    queryFn: () => connectionsApi.get({ id: id ?? '' }),
    enabled: !!id,
  })
}

export function useCreateConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateConnectionRequest) => connectionsApi.create(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] })
    },
  })
}

export function useDeleteConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => connectionsApi.remove({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] })
      void queryClient.invalidateQueries({ queryKey: ['connection'] })
    },
  })
}

export function useTestConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => connectionsApi.test({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections'] })
      void queryClient.invalidateQueries({ queryKey: ['connection'] })
    },
  })
}

export function useProjectApiKeysQuery() {
  const projectId = apiClient.getProjectId()
  return useQuery({
    queryKey: ['project-api-keys', projectId],
    queryFn: () => apiKeysApi.list(),
    // Standardized global error convention per AGENTS.md
    meta: { showErrorDialog: true },
  })
}

export function useCreateProjectApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: { displayName: string, projectId: string }) => apiKeysApi.create(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-api-keys'] })
    },
  })
}

export function useDeleteProjectApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiKeysApi.remove({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-api-keys'] })
    },
  })
}

/**
 * Minor/auxiliary query: only used to gate the Platform API Keys section, so it
 * intentionally has no `showErrorDialog` — a failure here just leaves the platform
 * key section hidden rather than surfacing a distracting toast.
 */
export function usePlatformQuery({ platformId }: { platformId?: string }) {
  return useQuery({
    queryKey: ['platform', platformId],
    queryFn: () => platformApi.get({ platformId: platformId ?? '' }),
    enabled: !!platformId,
  })
}

export function usePlatformApiKeysQuery({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['platform-api-keys'],
    queryFn: () => platformApiKeysApi.list(),
    enabled,
    meta: { showErrorDialog: true },
  })
}

export function useCreatePlatformApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: { displayName: string }) => platformApiKeysApi.create(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-api-keys'] })
    },
  })
}

export function useDeletePlatformApiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => platformApiKeysApi.remove({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-api-keys'] })
    },
  })
}

export function useCreateOAuthAuthorizationUrl() {
  return useMutation({
    mutationFn: (request: OAuth2AuthorizationUrlRequest) =>
      connectionsApi.oauth2AuthorizationUrl(request),
  })
}

export function useExecuteTool() {
  return useMutation<ExecuteResponse, unknown, ExecuteRequest>({
    mutationFn: (request: ExecuteRequest) => executeApi.run(request),
  })
}

export function useIntegrationOptions() {
  return useMutation({
    mutationFn: (request: IntegrationOptionsRequest) =>
      apiClient.post<DropdownState>('/integrations/options', request),
  })
}

export function useKnowledgeSearch(request: KnowledgeSearchRequest, enabled = true) {
  return useQuery({
    queryKey: ['knowledge-search', request],
    queryFn: () => apiClient.post<KnowledgeSearchResponse>('/knowledge-search/query', request),
    enabled,
    placeholderData: keepPreviousData,
  })
}

export function useTriggerBindingsQuery(options?: { enabled?: boolean; showErrorToast?: boolean }) {
  const showErrorToast = options?.showErrorToast ?? true
  return useQuery({
    queryKey: ['trigger-bindings', apiClient.getProjectId()],
    queryFn: () => automationsApi.listTriggerBindings(),
    select: (page) => page.data,
    // Every current call site (Trigger Bindings list, Dashboard summary) renders
    // this as primary data, so a fetch failure should surface an error dialog.
    meta: { showErrorToast },
    enabled: options?.enabled,
  })
}

export function useTriggerBindingsInfiniteQuery(
  options?: { enabled?: boolean; showErrorToast?: boolean }
) {
  const projectId = apiClient.getProjectId()
  const showErrorToast = options?.showErrorToast ?? true
  return useInfiniteQuery({
    queryKey: ['trigger-bindings', 'infinite', projectId],
    queryFn: ({ pageParam }) =>
      automationsApi.listTriggerBindings(pageParam ? { cursor: pageParam } : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    meta: { showErrorToast },
    enabled: options?.enabled,
  })
}

export function useTriggerBindingQuery(id?: string) {
  return useQuery({
    queryKey: ['trigger-binding', id],
    queryFn: () => apiClient.get<TriggerBinding>(`/trigger-bindings/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  })
}

export function useCreateTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateTriggerBindingRequest) =>
      automationsApi.createTriggerBinding(request),
    onSuccess: (binding) => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-bindings'] })
      void queryClient.invalidateQueries({ queryKey: ['trigger-binding', binding.id] })
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useUpdateTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateTriggerBindingRequest }) =>
      apiClient.post<TriggerBinding>(`/trigger-bindings/${encodeURIComponent(id)}`, request),
    onSuccess: (binding) => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-bindings'] })
      void queryClient.invalidateQueries({ queryKey: ['trigger-binding', binding.id] })
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useEnableTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiClient.post<TriggerBinding>(`/trigger-bindings/${encodeURIComponent(id)}/enable`),
    onSuccess: (binding) => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-bindings'] })
      void queryClient.invalidateQueries({ queryKey: ['trigger-binding', binding.id] })
    },
  })
}

export function useDisableTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiClient.post<TriggerBinding>(`/trigger-bindings/${encodeURIComponent(id)}/disable`),
    onSuccess: (binding) => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-bindings'] })
      void queryClient.invalidateQueries({ queryKey: ['trigger-binding', binding.id] })
    },
  })
}

export function useDeleteTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiClient.delete<void>(`/trigger-bindings/${encodeURIComponent(id)}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['trigger-bindings'] })
      void queryClient.removeQueries({ queryKey: ['trigger-binding', variables.id] })
    },
  })
}

export function useRunTriggerBinding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload?: unknown }) =>
      apiClient.post<Execution[]>(`/trigger-bindings/${encodeURIComponent(id)}/run`, payload),
    // A manual run records executions the same way useRunScheduledTaskNow does
    // (its sibling invalidates ['executions'] on success), so the Activity list,
    // the Dashboard "Recent Executions" card and the command palette must not
    // keep serving the pre-run cache for the whole 2-minute staleTime.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useScheduledTasksQuery(options?: { enabled?: boolean; showErrorToast?: boolean }) {
  const showErrorToast = options?.showErrorToast ?? true
  return useQuery({
    queryKey: ['scheduled-tasks', apiClient.getProjectId()],
    queryFn: () => automationsApi.listScheduledTasks(),
    select: (page) => page.data,
    // Every current call site (Scheduled Tasks list, Dashboard summary) renders
    // this as primary data, so a fetch failure should surface an error dialog.
    meta: { showErrorToast },
    enabled: options?.enabled,
  })
}

export function useScheduledTasksInfiniteQuery(
  options?: { enabled?: boolean; showErrorToast?: boolean }
) {
  const projectId = apiClient.getProjectId()
  const showErrorToast = options?.showErrorToast ?? true
  return useInfiniteQuery({
    queryKey: ['scheduled-tasks', 'infinite', projectId],
    queryFn: ({ pageParam }) =>
      automationsApi.listScheduledTasks(pageParam ? { cursor: pageParam } : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    meta: { showErrorToast },
    enabled: options?.enabled,
  })
}

export function useScheduledTaskQuery(id?: string) {
  return useQuery({
    queryKey: ['scheduled-task', id],
    queryFn: () => apiClient.get<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  })
}

export function useCreateScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateScheduledTaskRequest) =>
      automationsApi.createScheduledTask(request),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['scheduled-task', task.id] })
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useUpdateScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateScheduledTaskRequest }) =>
      apiClient.post<ScheduledTask>(`/scheduled-tasks/${encodeURIComponent(id)}`, request),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['scheduled-task', task.id] })
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useDeleteScheduledTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiClient.delete<void>(`/scheduled-tasks/${encodeURIComponent(id)}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      void queryClient.removeQueries({ queryKey: ['scheduled-task', variables.id] })
    },
  })
}

export function useRunScheduledTaskNow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiClient.post<Execution>(`/scheduled-tasks/${encodeURIComponent(id)}/run`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['executions'] })
    },
  })
}

export function useMcpServerQuery(projectId?: string) {
  const effectiveProjectId = projectId ?? apiClient.getProjectId()
  return useQuery({
    queryKey: ['mcp-server', effectiveProjectId],
    queryFn: () => apiClient.get<PopulatedMcpServer>(`/projects/${encodeURIComponent(effectiveProjectId ?? '')}/mcp-server`),
    enabled: !!effectiveProjectId,
    // Sole call site is the MCP Hub page, where this is the primary data driving
    // the whole page.
    meta: { showErrorDialog: true },
  })
}

export function useUpdateMcpTools() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, request }: { projectId: string; request: UpdateMcpServerRequest }) =>
      apiClient.post<PopulatedMcpServer>(`/projects/${encodeURIComponent(projectId)}/mcp-server`, request),
    onMutate: async ({ projectId, request }) => {
      await queryClient.cancelQueries({ queryKey: ['mcp-server'] })
      const previous = queryClient.getQueryData<PopulatedMcpServer>(['mcp-server', projectId])
      if (previous && request.disabledTools !== undefined) {
        queryClient.setQueryData<PopulatedMcpServer>(['mcp-server', projectId], {
          ...previous,
          disabledTools: request.disabledTools,
        })
      }
      return { previous, projectId }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData<PopulatedMcpServer>(['mcp-server', context.projectId], context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp-server'] })
    },
  })
}

export function useRotateMcpToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      apiClient.post<PopulatedMcpServer>(`/projects/${encodeURIComponent(projectId)}/mcp-server/rotate`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp-server'] })
    },
  })
}

export function useGenerateMcpToken() {
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      apiClient.post<GenerateMcpTokenResponse>(`/projects/${encodeURIComponent(projectId)}/mcp-server/token`),
  })
}

export function useExecutionsQuery(
  params?: { status?: ExecutionStatus; limit?: number },
  options?: { enabled?: boolean; showErrorToast?: boolean }
) {
  const projectId = apiClient.getProjectId()
  const showErrorToast = options?.showErrorToast ?? true
  return useQuery({
    queryKey: ['executions', params ?? {}, projectId],
    queryFn: () => executionsApi.list({ status: params?.status, limit: params?.limit }),
    placeholderData: keepPreviousData,
    // Every current call site (Activity list, Dashboard "Recent Executions") renders
    // this as primary data, so a fetch failure should surface an error dialog.
    meta: { showErrorToast },
    enabled: options?.enabled,
  })
}

export function useExecutionQuery(id?: string) {
  return useQuery({
    queryKey: ['execution', id],
    queryFn: () => executionsApi.get({ id: id ?? '' }),
    enabled: !!id,
  })
}

/**
 * Kept in the query cache only — tool call input/output is untrusted, unredacted
 * payload data and must never be persisted to browser storage.
 */
export function useExecutionToolCallsQuery(id?: string) {
  return useQuery({
    queryKey: ['execution-tool-calls', id],
    queryFn: () => executionsApi.listToolCalls({ id: id ?? '' }),
    enabled: !!id,
    gcTime: 0,
  })
}

export function useBillingInfoQuery() {
  return useQuery({
    queryKey: ['platform-billing-info'],
    queryFn: () => billingApi.getInfo(),
    staleTime: 60_000,
    retry: false,
  })
}

export function useCreateBillingPortalMutation() {
  return useMutation({
    mutationFn: () => billingApi.createPortalSession(),
  })
}

export function useCreateBillingCheckoutMutation() {
  return useMutation({
    mutationFn: ({ newActiveFlowsLimit }: { newActiveFlowsLimit: number }) =>
      billingApi.createCheckoutSession({ newActiveFlowsLimit }),
  })
}

export function useAIProvidersQuery() {
  return useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => aiProvidersApi.list(),
    meta: { showErrorToast: true },
  })
}

export function useAIProviderModelsQuery(provider?: AIProviderName, enabled = true) {
  return useQuery({
    queryKey: ['ai-provider-models', provider],
    queryFn: () => (provider ? aiProvidersApi.listModels(provider) : Promise.resolve([])),
    enabled: !!provider && enabled,
    staleTime: 60_000,
  })
}

export function useCreateAIProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateAIProviderRequest) => aiProvidersApi.create(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
    },
  })
}

export function useUpdateAIProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateAIProviderRequest }) =>
      aiProvidersApi.update(id, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
    },
  })
}

export function useDeleteAIProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => aiProvidersApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
    },
  })
}


