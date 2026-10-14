import { SeekPage } from '@inboxfm-connect/core-utils'
import { FlowsContext, ListFlowsContextParams, PopulatedFlowSummary } from '@inboxfm-connect/pieces-framework'
import { FetchError } from '@inboxfm-connect/shared'

export const createFlowsContext = ({ engineToken, internalApiUrl, flowId, flowVersionId }: CreateFlowsServiceParams): FlowsContext => {
    return {
        async list(params?: ListFlowsContextParams): Promise<SeekPage<PopulatedFlowSummary>> {
            const queryParams = new URLSearchParams()
            if (params?.externalIds) {
                queryParams.set('externalIds', params.externalIds.join(','))
            }
            const url = `${internalApiUrl}v1/engine/populated-flows?${queryParams.toString()}`
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
