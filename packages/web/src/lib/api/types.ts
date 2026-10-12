export interface ExecuteRequest {
  /**
   * Required by the backend authorization layer (ProjectResourceType.BODY), not by
   * the runtime. Resolved from the active project when omitted at the call site.
   */
  projectId?: string
  integration: string
  tool: string
  connectionId: string
  input: Record<string, unknown>
}

/**
 * `POST /v1/execute` returns the RAW piece action output.
 *
 * The controller returns `runtime.execute(...)` directly and declares its response
 * schema as `z.unknown()`. There is NO framework-level envelope: no `success` flag,
 * no `error` string, no `standardOutput`. The HTTP status is the only success or
 * failure signal — an action that happens to return `{ success: false }` is still a
 * successful execution whose output says so.
 */
export type ExecuteResponse = unknown

export interface IntegrationOptionsRequest {
  projectId?: string
  pieceName: string
  pieceVersion: string
  actionOrTriggerName: string
  propertyName: string
  input: Record<string, unknown>
  searchValue?: string
}

export interface KnowledgeSearchResultItem {
  pieceName: string
  objectName: string
  objectKind: 'action' | 'trigger'
  displayName: string
  oneLineDescription?: string
  requiresConnection: boolean
  cosine?: number
  connected?: boolean
}

export interface KnowledgeSearchRequest {
  query: string
  limit?: number
  objectKind?: 'action' | 'trigger' | 'all'
  pieceName?: string
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResultItem[]
  mode: 'semantic' | 'keyword'
}

export interface PieceSummary {
  name: string
  displayName: string
  logoUrl: string
  description: string
  version: string
  actions: number
  triggers: number
  categories: string[]
  auth?: {
    type: string
    required: boolean
  }
}

export interface DropdownOption {
  label: string
  value: unknown
}

export type DropdownState = {
  disabled?: boolean
  placeholder?: string
  options: DropdownOption[]
}

export interface ArraySubProperty {
  displayName: string
  description?: string
  required: boolean
  type: string
  options?: DropdownState
  defaultValue?: unknown
}

export interface PieceProperty {
  displayName: string
  description?: string
  required: boolean
  type: string
  options?: DropdownState
  defaultValue?: unknown
  properties?: Record<string, ArraySubProperty>
}

export interface PieceAction {
  name: string
  displayName: string
  description: string
  props: Record<string, PieceProperty>
  requireAuth?: boolean
}

export interface PieceTrigger {
  name: string
  displayName: string
  description: string
  type: 'POLLING' | 'WEBHOOK'
  props: Record<string, PieceProperty>
  sampleData?: unknown
}

export interface PieceAuthMetadata {
  type: string
  description?: string
  required?: boolean
  props?: Record<string, PieceProperty>
  scope?: string[]
  authorizationMethod?: 'HEADER' | 'BODY'
}

export interface PieceMetadata {
  name: string
  displayName: string
  logoUrl: string
  description: string
  version: string
  categories?: string[]
  auth?: PieceAuthMetadata
  actions: Record<string, PieceAction>
  triggers: Record<string, PieceTrigger>
}

export type AppConnectionType = 'OAUTH2' | 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH'

export type AppConnectionStatus = 'ACTIVE' | 'ERROR'

export interface AppConnection {
  id: string
  created: string
  updated: string
  displayName: string
  pieceName: string
  pieceVersion: string
  type: AppConnectionType
  status: AppConnectionStatus
  /** Always present in the backend response (`AppConnectionWithoutSensitiveData` declares it required). */
  externalId: string
  projectIds: string[]
}

export interface TestConnectionResult {
  ok: boolean
  status: AppConnectionStatus
  testedAt: string
  message?: string
}

export interface CreateConnectionRequest {
  /** Required by the backend authorization layer; resolved from the active project when omitted. */
  projectId?: string
  displayName: string
  pieceName: string
  pieceVersion: string
  type: AppConnectionType
  value: CreateConnectionValue
  /** Required by the backend upsert schema (`UpsertAppConnectionRequestBody`) in every auth branch; mint one with `connectionIds.newExternalId()` for new connections. */
  externalId: string
  metadata?: Record<string, unknown>
}

export type CreateConnectionValue =
  | { type: 'SECRET_TEXT'; secret_text: string }
  | { type: 'BASIC_AUTH'; username: string; password: string }
  | { type: 'CUSTOM_AUTH'; props: Record<string, unknown> }
  | OAuth2ConnectionValueInput

export interface OAuth2ConnectionValueInput {
  type: 'OAUTH2'
  client_id: string
  client_secret: string
  code: string
  scope: string
  redirect_url: string
  code_challenge?: string
  props?: Record<string, unknown>
  authorization_method?: 'HEADER' | 'BODY'
}

export interface OAuth2AuthorizationUrlRequest {
  pieceName: string
  pieceVersion?: string
  clientId: string
  redirectUrl: string
  scopes?: string[]
  props?: Record<string, unknown>
}

export interface OAuth2AuthorizationUrlResponse {
  authorizationUrl: string
  codeVerifier?: string
}

export type AutomationStatus = 'ENABLED' | 'DISABLED'

export interface TriggerBinding {
  id: string
  created: string
  updated: string
  projectId: string
  platformId: string
  pieceName: string
  pieceVersion: string
  triggerName: string
  connectionId: string | null
  promptTemplate: string
  settings: Record<string, unknown>
  propertySettings?: Record<string, unknown>
  status: AutomationStatus
}

export interface ScheduledTask {
  id: string
  created: string
  updated: string
  projectId: string
  platformId: string
  prompt: string
  cronExpression: string
  timezone: string
  status: AutomationStatus
  lastRunAt: string | null
  nextRunAt: string | null
}

export type McpServerType = 'PLATFORM' | 'PROJECT'

export interface McpServer {
  id: string
  created: string
  updated: string
  platformId: string | null
  projectId: string | null
  type: McpServerType
  token: string
  disabledTools: string[] | null
}

export interface PopulatedMcpServer extends McpServer {
  flows: unknown[]
}

export interface UpdateMcpServerRequest {
  disabledTools?: string[]
}

export interface GenerateMcpTokenResponse {
  mcpServerUrl: string
  mcpToken: string
}

export type ExecutionStatus = 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface Execution {
  id: string
  created: string
  updated: string
  projectId: string
  platformId: string
  userId?: string | null
  status: ExecutionStatus
  prompt: string
  metadata: Record<string, unknown>
  tokenUsage?: TokenUsage | null
  cost?: number | null
  finishTime?: string | null
}

export type ExecutionToolCallStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export interface ToolCallError {
  message: string
  code?: string
  stack?: string
}

export interface ToolCall {
  id: string
  created: string
  updated: string
  executionId: string
  projectId: string
  pieceName: string
  pieceVersion: string
  actionName: string
  connectionId?: string | null
  input: Record<string, unknown>
  output?: unknown | null
  status: ExecutionToolCallStatus
  error?: ToolCallError | null
  latencyMs?: number | null
  finished?: string | null
}

export type KnownExecutionEventType =
  | 'ExecutionStarted'
  | 'PlannerStarted'
  | 'ToolStarted'
  | 'ToolFinished'
  | 'ToolFailed'
  | 'ExecutionCompleted'
  | 'ExecutionFailed'
  | 'ExecutionCancelled'

/**
 * The wire value of `ExecutionEvent.type`.
 *
 * Kept open on purpose: the backend enum may grow, and the timeline renderer must
 * display a newly wired event type instead of dropping it. The known literals stay
 * listed so editors still autocomplete them.
 */
export type ExecutionEventType = KnownExecutionEventType | (string & NonNullable<unknown>)

export interface ExecutionStartedEventPayload {
  executionId: string
  prompt: string
  timestamp: string
}

export interface PlannerStartedEventPayload {
  executionId: string
  model: string
  timestamp: string
}

export interface ToolStartedEventPayload {
  executionId: string
  toolCallId: string
  pieceName: string
  actionName: string
  input: Record<string, unknown>
}

export interface ToolFinishedEventPayload {
  executionId: string
  toolCallId: string
  output?: unknown
  latencyMs: number
}

export interface ToolFailedEventPayload {
  executionId: string
  toolCallId: string
  error: ToolCallError
}

export interface ExecutionCompletedEventPayload {
  executionId: string
  output?: unknown
  totalTokens?: number | null
  durationMs?: number | null
}

export interface ExecutionFailedEventPayload {
  executionId: string
  error: { message: string; code?: string }
}

export interface ExecutionCancelledEventPayload {
  executionId: string
  reason?: string
}

/**
 * Wire format of GET /v1/executions/:id/events frames.
 * `payload` stays an open record on the wire; the payload interfaces above
 * describe the known shapes per event type.
 */
export interface ExecutionEvent {
  id: string
  executionId: string
  type: ExecutionEventType
  timestamp: string
  payload: Record<string, unknown>
}

export interface ListExecutionsParams {
  projectId?: string
  status?: ExecutionStatus
  limit?: number
}

export interface ExecutionsListResponse<T> {
  data: T[]
  next: string | null
  previous: string | null
}

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  platformRole?: string
  platformId?: string
}

export interface Project {
  id: string
  displayName: string
  platformId: string
}

export interface ProjectApiKey {
  id: string
  created: string
  displayName: string
  platformId: string
  projectId: string
  truncatedValue: string
  lastUsedAt: string | null
}

export interface ProjectApiKeyWithValue extends ProjectApiKey {
  value: string
}

/** Platform-wide `sk-` key. Creation/listing is gated server-side by `platform.plan.apiKeysEnabled`. */
export interface PlatformApiKey {
  id: string
  created: string
  displayName: string
  platformId: string
  truncatedValue: string
  lastUsedAt: string | null
}

export interface PlatformApiKeyWithValue extends PlatformApiKey {
  value: string
}

export interface PlatformPlan {
  apiKeysEnabled: boolean
}

export interface PlatformWithPlan {
  id: string
  plan: PlatformPlan
}

export interface SeekPage<T> {
  data: T[]
  next: string | null
  previous: string | null
}

export type IntegrationsSortBy = 'NAME' | 'POPULARITY'
export type IntegrationsOrderBy = 'ASC' | 'DESC'

export type IntegrationsListParams = {
  searchQuery?: string
  categories?: string[]
  sortBy?: IntegrationsSortBy
  orderBy?: IntegrationsOrderBy
  suggestionType?: 'ACTION' | 'TRIGGER'
  cursor?: string
  limit?: number
}

export type ConnectionsListParams = {
  /** Required by the backend authorization layer; resolved from the active project when omitted. */
  projectId?: string
  pieceName?: string
  displayName?: string
  status?: 'ACTIVE' | 'ERROR'
  cursor?: string
  limit?: number
}

export interface CreateTriggerBindingRequest {
  /** Required by the backend authorization layer; resolved from the active project when omitted. */
  projectId?: string
  pieceName: string
  pieceVersion: string
  triggerName: string
  connectionId: string | null
  promptTemplate: string
  settings: Record<string, unknown>
  propertySettings?: Record<string, unknown>
  status?: AutomationStatus
}

export interface UpdateTriggerBindingRequest {
  pieceName?: string
  pieceVersion?: string
  triggerName?: string
  connectionId: string | null
  promptTemplate?: string
  settings?: Record<string, unknown>
  propertySettings?: Record<string, unknown>
  status?: AutomationStatus
}

export interface CreateScheduledTaskRequest {
  /** Required by the backend authorization layer; resolved from the active project when omitted. */
  projectId?: string
  prompt: string
  cronExpression: string
  timezone?: string
  status?: AutomationStatus
}

export interface UpdateScheduledTaskRequest {
  prompt?: string
  cronExpression?: string
  timezone?: string
  status?: AutomationStatus
}

export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'

export interface PlatformPlanInfo {
  plan: string
  stripeSubscriptionStatus?: SubscriptionStatus
  stripeSubscriptionId?: string
  stripeCustomerId?: string
  activeFlowsLimit?: number
  includedAiCredits?: number
}

export interface PlatformUsageInfo {
  activeFlows?: number
  aiCreditsLimit?: number
  aiCreditsRemaining?: number
  totalAiCreditsUsed?: number
}

export interface PlatformBillingInformation {
  stripeBillingEnabled: boolean
  plan: PlatformPlanInfo
  usage: PlatformUsageInfo
  nextBillingAmount?: number
  nextBillingDate?: number
  cancelAt?: number
}

