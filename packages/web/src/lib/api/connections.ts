import { apiClient } from './client'
import {
  AppConnection,
  ConnectionsListParams,
  CreateConnectionRequest,
  OAuth2AuthorizationUrlRequest,
  OAuth2AuthorizationUrlResponse,
  SeekPage,
  TestConnectionResult,
} from './types'

/**
 * The backend registers this controller at `/v1/connections`
 * (`app-connection.module.ts`), not `/v1/app-connections` — the latter is only an
 * OpenAPI tag. Every path here is verified against that registration.
 */
const CONNECTIONS_PATH = '/connections'

function resolveProjectId(projectId?: string): string | undefined {
  return projectId ?? apiClient.getProjectId() ?? undefined
}

const connectionsApi = {
  /** `GET /v1/connections` is guarded by ProjectResourceType.QUERY. */
  list({ projectId, ...filters }: ConnectionsListParams = {}): Promise<SeekPage<AppConnection>> {
    const effectiveProjectId = resolveProjectId(projectId)
    return apiClient.get<SeekPage<AppConnection>>(CONNECTIONS_PATH, {
      params: {
        ...filters,
        ...(effectiveProjectId !== undefined ? { projectId: effectiveProjectId } : {}),
      },
    })
  },

  /** Detail and delete derive the tenant from the connection row itself. */
  get({ id }: { id: string }): Promise<AppConnection> {
    return apiClient.get<AppConnection>(`${CONNECTIONS_PATH}/${encodeURIComponent(id)}`)
  },

  /** `POST /v1/connections` is guarded by ProjectResourceType.BODY. */
  create(request: CreateConnectionRequest): Promise<AppConnection> {
    const projectId = resolveProjectId(request.projectId)
    return apiClient.post<AppConnection>(CONNECTIONS_PATH, {
      ...request,
      ...(projectId !== undefined ? { projectId } : {}),
    })
  },

  remove({ id }: { id: string }): Promise<void> {
    return apiClient.delete<void>(`${CONNECTIONS_PATH}/${encodeURIComponent(id)}`)
  },

  /** Health check: decrypt + refresh, returns pass/fail and updates row status. */
  test({ id }: { id: string }): Promise<TestConnectionResult> {
    return apiClient.post<TestConnectionResult>(`${CONNECTIONS_PATH}/${encodeURIComponent(id)}/test`, {})
  },

  oauth2AuthorizationUrl(request: OAuth2AuthorizationUrlRequest): Promise<OAuth2AuthorizationUrlResponse> {
    return apiClient.post<OAuth2AuthorizationUrlResponse>(
      `${CONNECTIONS_PATH}/oauth2/authorization-url`,
      request,
    )
  },
}

export { connectionsApi }
