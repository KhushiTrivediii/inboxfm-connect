import { ToolSearchEmbedder } from '../../../../src/app/tool-search/embedder'
import { knowledgeSearchService } from '../../../../src/app/knowledge-search/knowledge-search.service'
import { toolSearchService } from '../../../../src/app/tool-search/tool-search.service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Issue: objectKind 'all' runs searchActions + searchTriggers over the same query.
// Each semantic branch embeds the query independently, so one unified search pays
// the embedding API twice for one identical string, and (when no embedder is passed
// in) resolves the embedder - provider-config DB read + decryption - twice too.
// The service must hand both branches ONE memoizing embedder.

const passedEmbedders: (ToolSearchEmbedder | undefined)[] = []

vi.mock('../../../../src/app/tool-search/tool-search.service', () => ({
    toolSearchService: vi.fn(() => ({
        searchActions: async (_q: string, opts: Record<string, unknown>) => {
            passedEmbedders.push(opts['embedder'] as ToolSearchEmbedder | undefined)
            return { results: [], mode: 'semantic' }
        },
        searchTriggers: async (_q: string, opts: Record<string, unknown>) => {
            passedEmbedders.push(opts['embedder'] as ToolSearchEmbedder | undefined)
            return { results: [], mode: 'semantic' }
        },
    })),
}))

function countingEmbedder(): { embedder: ToolSearchEmbedder, embedCalls: () => number } {
    let calls = 0
    const embedder: ToolSearchEmbedder = {
        modelVersion: 'test:v1',
        dimensions: 3,
        tau: 0.5,
        async embed(_texts: string[]): Promise<number[][]> {
            calls++
            return [[0.1, 0.2, 0.3]]
        },
    }
    return { embedder, embedCalls: () => calls }
}

beforeEach(() => {
    passedEmbedders.length = 0
})

describe('knowledge search unified query - embed cost dedup', () => {
    it('hands both branches the same resolved/memoized embedder (one object, not two)', async () => {
        const { embedder } = countingEmbedder()
        await knowledgeSearchService({} as never).query({
            query: 'send a slack message',
            objectKind: 'all',
            platformId: 'platform-x',
            embedder,
        })
        expect(passedEmbedders.length).toBe(2)
        expect(passedEmbedders[0]).toBeDefined()
        expect(passedEmbedders[0]).toBe(passedEmbedders[1])
    })

    it('memoizes the shared query embedding - two embeds of the same text hit the API once', async () => {
        const { embedder, embedCalls } = countingEmbedder()
        await knowledgeSearchService({} as never).query({
            query: 'send a slack message',
            objectKind: 'all',
            platformId: 'platform-x',
            embedder,
        })
        const passed = passedEmbedders[0]!
        expect(passed).not.toBe(embedder) // wrapped, memoizing
        const [a1, b1] = await Promise.all([
            passed.embed(['send a slack message']),
            passed.embed(['send a slack message']),
        ])
        expect(a1).toEqual(b1)
        expect(embedCalls()).toBe(1)
        // a different text must NOT hit the memo
        await passed.embed(['another query'])
        expect(embedCalls()).toBe(2)
    })
})

describe('null embedder propagation (codeant on #405)', () => {
    it('omits the embedder key when resolution returned null - no explicit null downstream', async () => {
        await knowledgeSearchService({} as never).query({
            query: 'send a slack message',
            objectKind: 'action',
            platformId: 'platform-x',
            embedder: null,
        })
        expect(passedEmbedders.length).toBe(1)
        expect(passedEmbedders[0]).toBeUndefined()
    })

    it('still wraps and passes a resolved embedder to single-kind branches', async () => {
        const { embedder } = countingEmbedder()
        await knowledgeSearchService({} as never).query({
            query: 'send a slack message',
            objectKind: 'trigger',
            platformId: 'platform-x',
            embedder,
        })
        expect(passedEmbedders.length).toBe(1)
        expect(passedEmbedders[0]).toBeDefined()
        expect(passedEmbedders[0]).not.toBe(embedder) // memo-wrapped
    })
})
