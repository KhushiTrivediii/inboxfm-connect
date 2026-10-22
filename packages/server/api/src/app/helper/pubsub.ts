import { isNil } from '@inboxfm-connect/core-utils'
import { Mutex } from 'async-mutex'
import Redis from 'ioredis'
import { redisConnections } from '../database/redis-connections'

let redisClientSubscriber: Redis | null = null
let redisClientPublisher: Redis | null = null
const mutexLock = new Mutex()

const channelListeners = new Map<string, Set<(message: string) => void>>()

export const pubsub = {
    async subscribe(
        channel: string,
        listener: (message: string) => void,
    ): Promise<void> {
        const subscriber = await getRedisClientSubscriber()
        let listeners = channelListeners.get(channel)
        const isFirst = isNil(listeners) || listeners.size === 0
        if (isNil(listeners)) {
            listeners = new Set()
            channelListeners.set(channel, listeners)
        }
        listeners.add(listener)
        if (isFirst) {
            await subscriber.subscribe(channel)
        }
    },
    async publish(channel: string, message: string): Promise<void> {
        const publisher = await getRedisClientPublisher()
        await publisher.publish(channel, message)
    },
    async unsubscribe(channel: string, listener?: (message: string) => void): Promise<void> {
        const subscriber = await getRedisClientSubscriber()
        const listeners = channelListeners.get(channel)
        if (!isNil(listeners)) {
            if (!isNil(listener)) {
                listeners.delete(listener)
            }
            else {
                listeners.clear()
            }
            if (listeners.size === 0) {
                channelListeners.delete(channel)
                await subscriber.unsubscribe(channel)
            }
        }
        else {
            await subscriber.unsubscribe(channel)
        }
    },
    async close(): Promise<void> {
        channelListeners.clear()
        if (!isNil(redisClientSubscriber)) {
            await redisClientSubscriber.quit()
            redisClientSubscriber = null
        }
        if (!isNil(redisClientPublisher)) {
            await redisClientPublisher.quit()
            redisClientPublisher = null
        }
    },
}

async function getRedisClientSubscriber(): Promise<Redis> {
    if (!isNil(redisClientSubscriber)) {
        return redisClientSubscriber
    }

    return mutexLock.runExclusive(async () => {
        if (!isNil(redisClientSubscriber)) {
            return redisClientSubscriber
        }
        const client = await redisConnections.create()
        client.on('message', (channel: string, message: string) => {
            const listeners = channelListeners.get(channel)
            if (!isNil(listeners)) {
                for (const listener of listeners) {
                    try {
                        listener(message)
                    }
                    catch (err) {
                        // Ignore listener errors
                    }
                }
            }
        })
        redisClientSubscriber = client
        return redisClientSubscriber
    })
}

async function getRedisClientPublisher(): Promise<Redis> {
    if (!isNil(redisClientPublisher)) {
        return redisClientPublisher
    }

    return mutexLock.runExclusive(async () => {
        if (!isNil(redisClientPublisher)) {
            return redisClientPublisher
        }
        redisClientPublisher = await redisConnections.create()
        return redisClientPublisher
    })
}
