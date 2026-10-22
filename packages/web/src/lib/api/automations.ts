import { apiClient } from './client'
import {
  CreateScheduledTaskRequest,
  CreateTriggerBindingRequest,
  ScheduledTask,
  SeekPage,
  TriggerBinding,
} from './types'

function resolveProjectId(projectId?: string): string | undefined {
  return projectId ?? apiClient.getProjectId() ?? undefined
}

function withProjectId<T extends { projectId?: string }>(request: T): T {
  const projectId = resolveProjectId(request.projectId)
  return projectId === undefined ? request : { ...request, projectId }
}

function projectQuery(): Record<string, string> {
  const projectId = resolveProjectId()
  return projectId === undefined ? {} : { projectId }
}

/**
 * Trigger binding and scheduled task collection routes are guarded by
 * ProjectResourceType.QUERY (lists) and ProjectResourceType.BODY (creates), so both
 * must carry `projectId` or the authorization layer rejects every USER principal.
 * The `/:id` routes are omitted here on purpose — they resolve the tenant from the
 * row itself and must never be handed a client-asserted project.
 */
const automationsApi = {
  listTriggerBindings(params?: { cursor?: string; limit?: number }): Promise<SeekPage<TriggerBinding>> {
    return apiClient.get<SeekPage<TriggerBinding>>('/trigger-bindings', {
      params: { ...projectQuery(), ...params },
    })
  },

  createTriggerBinding(request: CreateTriggerBindingRequest): Promise<TriggerBinding> {
    return apiClient.post<TriggerBinding>('/trigger-bindings', withProjectId(request))
  },

  listScheduledTasks(params?: { cursor?: string; limit?: number }): Promise<SeekPage<ScheduledTask>> {
    return apiClient.get<SeekPage<ScheduledTask>>('/scheduled-tasks', {
      params: { ...projectQuery(), ...params },
    })
  },

  createScheduledTask(request: CreateScheduledTaskRequest): Promise<ScheduledTask> {
    return apiClient.post<ScheduledTask>('/scheduled-tasks', withProjectId(request))
  },
}

export { automationsApi }
