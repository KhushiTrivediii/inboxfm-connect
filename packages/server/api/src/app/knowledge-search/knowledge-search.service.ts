import { isNil } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { ToolSearchEmbedder } from '../tool-search/embedder'
import { resolveEmbedder } from '../tool-search/resolve-embedder'
import { toolSearchService } from '../tool-search/tool-search.service'

/**
 * Knowledge Search Service — First-class AI runtime capability for tool & integration discovery.
 * Wraps toolSearchService into a unified domain API for the AI planner and HTTP runtime callers.
 */
export const knowledgeSearchService = (log: FastifyBaseLogger): KnowledgeSearchService => ({
    async query(params: KnowledgeSearchQueryParams): Promise<KnowledgeSearchQueryResponse> {
        const { query, limit, pieceName, objectKind = 'all', audiences, platformId, projectId } = params

        // Unified ('all') searches run the action and trigger pipelines over the
        // SAME query text. Each semantic pipeline embeds the query independently,
        // so without dedup one unified search pays the embedding API twice for one
        // identical string - and, when no embedder is injected, resolves the
        // embedder (a provider-config DB read + decryption) twice as well. Resolve
        // once per query() call and wrap the embedder with a single-slot memo so
        // the shared text is embedded exactly once, while distinct texts still
        // pass through. Per-call scope: nothing is cached across requests.
        const resolvedEmbedder = await resolveEmbedderForQuery({ platformId, log, embedder: params.embedder })
        const memoizedEmbedder = memoizeSingleTextEmbedder(resolvedEmbedder)
        // A null embedder means semantic search is unavailable - for the single-kind
        // branches that is a plain absence, but passing explicit null down to
        // tool-search makes it indistinguishable from "not provided" at its
        // dispatcher (null ?? resolve re-resolves per branch: one provider-config
        // DB read + decrypt per branch). Omit the key entirely so each branch
        // resolves exactly once on its own - the pre-#405 behavior - and the
        // unified branch is covered by the single resolution above.

        const singleKindOpts = memoizedEmbedder === null
            ? { platformId, projectId, limit, pieceName, audiences }
            : { platformId, projectId, limit, pieceName, audiences, embedder: memoizedEmbedder }

        if (objectKind === 'action') {
            const { results, mode } = await toolSearchService(log).searchActions(query, singleKindOpts)
            const mappedResults: KnowledgeSearchResult[] = results.map((item) => ({
                pieceName: item.pieceName,
                objectName: item.actionName,
                objectKind: 'action',
                displayName: item.displayName,
                oneLineDescription: item.oneLineDescription,
                requiresConnection: item.requiresConnection,
                cosine: item.cosine,
                connected: item.connected,
            }))
            return { results: mappedResults, mode }
        }

        if (objectKind === 'trigger') {
            const { results, mode } = await toolSearchService(log).searchTriggers(query, singleKindOpts)
            const mappedResults: KnowledgeSearchResult[] = results.map((item) => ({
                pieceName: item.pieceName,
                objectName: item.triggerName,
                objectKind: 'trigger',
                displayName: item.displayName,
                oneLineDescription: item.oneLineDescription,
                requiresConnection: item.requiresConnection,
                cosine: item.cosine,
                connected: item.connected,
            }))
            return { results: mappedResults, mode }
        }

        const [actionsRes, triggersRes] = await Promise.all([
            toolSearchService(log).searchActions(query, {
                platformId,
                projectId,
                limit,
                pieceName,
                audiences,
                embedder: memoizedEmbedder,
            }),
            toolSearchService(log).searchTriggers(query, {
                platformId,
                projectId,
                limit,
                pieceName,
                embedder: memoizedEmbedder,
            }),
        ])

        const actionItems: KnowledgeSearchResult[] = actionsRes.results.map((item) => ({
            pieceName: item.pieceName,
            objectName: item.actionName,
            objectKind: 'action',
            displayName: item.displayName,
            oneLineDescription: item.oneLineDescription,
            requiresConnection: item.requiresConnection,
            cosine: item.cosine,
            connected: item.connected,
        }))

        const triggerItems: KnowledgeSearchResult[] = triggersRes.results.map((item) => ({
            pieceName: item.pieceName,
            objectName: item.triggerName,
            objectKind: 'trigger',
            displayName: item.displayName,
            oneLineDescription: item.oneLineDescription,
            requiresConnection: item.requiresConnection,
            cosine: item.cosine,
            connected: item.connected,
        }))

        const combined = [...actionItems, ...triggerItems]
        combined.sort((a, b) => {
            const scoreA = a.cosine ?? 0
            const scoreB = b.cosine ?? 0
            return scoreB - scoreA
        })

        const maxLimit = limit ?? DEFAULT_SEARCH_LIMIT
        const mode = actionsRes.mode === 'semantic' || triggersRes.mode === 'semantic' ? 'semantic' : 'keyword'

        return {
            results: combined.slice(0, maxLimit),
            mode,
        }
    },
})

const DEFAULT_SEARCH_LIMIT = 5

/**
 * Resolves the query-time embedder exactly once per query() call: an injected
 * embedder wins (test/telemetry seam), otherwise the platform embedder is
 * resolved from config. Returns null when semantic search is unavailable, so
 * both branches degrade to the keyword floor together.
 */
async function resolveEmbedderForQuery({ platformId, log, embedder }: { platformId?: string, log: FastifyBaseLogger, embedder?: ToolSearchEmbedder | null }): Promise<ToolSearchEmbedder | null> {
    if (!isNil(embedder)) {
        return embedder
    }
    if (isNil(platformId)) {
        return null
    }
    return resolveEmbedder({ platformId, log })
}

/**
 * Wraps an embedder with a one-slot memo over the embed CALL, not the text: two
 * concurrent embeds of the same texts array share one underlying API call (the
 * unified pipeline embedding the same query twice), while any different input
 * misses the memo and hits the API. A null embedder passes through as null.
 */
export function memoizeSingleTextEmbedder(embedder: ToolSearchEmbedder | null): ToolSearchEmbedder | null {
    if (isNil(embedder)) {
        return null
    }
    let inflight: Promise<number[][]> | null = null
    let memoKey: string | null = null
    return {
        ...embedder,
        async embed(texts: string[]): Promise<number[][]> {
            const key = JSON.stringify(texts)
            if (key === memoKey && inflight !== null) {
                return inflight
            }
            memoKey = key
            inflight = embedder.embed(texts)
            return inflight
        },
    }
}

export type ObjectKindFilter = 'action' | 'trigger' | 'all'

export type KnowledgeSearchResult = {
    pieceName: string
    objectName: string
    objectKind: 'action' | 'trigger'
    displayName: string
    oneLineDescription?: string
    requiresConnection: boolean
    cosine?: number
    connected?: boolean
}

export type KnowledgeSearchQueryParams = {
    query: string
    limit?: number
    objectKind?: ObjectKindFilter
    pieceName?: string
    audiences?: string[]
    platformId?: string
    projectId?: string
    embedder?: ToolSearchEmbedder | null
}

export type KnowledgeSearchQueryResponse = {
    results: KnowledgeSearchResult[]
    mode: 'semantic' | 'keyword'
}

export type KnowledgeSearchService = {
    query(params: KnowledgeSearchQueryParams): Promise<KnowledgeSearchQueryResponse>
}
