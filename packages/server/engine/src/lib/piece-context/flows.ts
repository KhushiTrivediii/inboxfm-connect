import { SeekPage } from '@inboxfm-connect/core-utils'
import { FlowsContext, ListFlowsContextParams } from '@inboxfm-connect/pieces-framework'
import { FetchError, PopulatedFlow } from '@inboxfm-connect/shared'

export const createFlowsContext = ({ engineToken, internalApiUrl, flowId, flowVersionId }: CreateFlowsServiceParams): FlowsContext => {
    // Callers pass the internal URL with or without a trailing slash (engine constants
    // carry one; headless params may not) — normalize so the endpoint is always well-formed.
    const baseApiUrl = internalApiUrl.endsWith('/') ? internalApiUrl : `${internalApiUrl}/`
    return {
        async list(params: ListFlowsContextParams): Promise<SeekPage<PopulatedFlow>> {
            const queryParams = new URLSearchParams()
            if (params?.externalIds) {
                queryParams.set('externalIds', params.externalIds.join(','))
            }
            const url = `${baseApiUrl}v1/engine/populated-flows?${queryParams.toString()}`
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${engineToken}`,
                },
            })
            if (!response.ok) {
                throw new FetchError(url, `status=${response.status}`)
            }
            return response.json()
        },
        current: {
            id: flowId,
            version: {
                id: flowVersionId,
            },
        },
    }
}

type CreateFlowsServiceParams = {
    engineToken: string
    internalApiUrl: string
    flowId: string
    flowVersionId: string
}
