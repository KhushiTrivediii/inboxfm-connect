import { apId, isNil } from '@inboxfm-connect/core-utils'
import { In } from 'typeorm'
import { repoFactory } from '../../../core/db/repo-factory'
import { tagService } from '../tag-service'
import { PieceTagEntity } from './piece-tag.entity'


const pieceTagsRepo = repoFactory(PieceTagEntity)

export const pieceTagService = {
    async set(platformId: string, pieceName: string, tags: string[]): Promise<void> {
        await pieceTagsRepo().delete({ pieceName, platformId })
        if (isNil(tags) || tags.length === 0) {
            return
        }
        const tagEntities = await Promise.all(tags.map(tag => tagService.upsert(platformId, tag)))
        const uniqueTagIds = Array.from(new Set(tagEntities.map(tag => tag.id)))
        if (uniqueTagIds.length === 0) {
            return
        }
        await pieceTagsRepo().upsert(uniqueTagIds.map(tagId => ({ id: apId(), tagId, pieceName, platformId })), ['tagId', 'pieceName'])
    },
    async findByPlatform(platformId: string):  Promise<Record<string, string[]>> {
        const pieceTags = await pieceTagsRepo().findBy({ platformId })
        const tagIds = Array.from(new Set(pieceTags.map(pieceTag => pieceTag.tagId)))
        const tags = await tagService.findNamesByIds(tagIds)
        return pieceTags.reduce((acc, pieceTag) => {
            acc[pieceTag.pieceName] = acc[pieceTag.pieceName] || []
            acc[pieceTag.pieceName].push(tags[pieceTag.tagId])
            return acc
        }, {} as Record<string, string[]>)
    },
    async deleteByTagId(tagId: string): Promise<void> {
        await pieceTagsRepo().delete({ tagId })
    },
    async findByPlatformAndTags(platformId: string, pieceTags: string[]): Promise<string[]> {
        if (isNil(pieceTags) || pieceTags.length === 0) {
            return []
        }
        const tagIds = await tagService.convertIdsToNames(platformId, pieceTags)
        if (tagIds.length === 0) {
            return []
        }
        const pieceTagEntities = await pieceTagsRepo().findBy({
            platformId,
            tagId: In(tagIds),
        })
        return Array.from(new Set(pieceTagEntities.map(pieceTag => pieceTag.pieceName)))
    },
}
