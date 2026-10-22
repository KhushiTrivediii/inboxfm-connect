import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { pubsub } from '../../../../src/app/helper/pubsub'

class FakeRedis extends EventEmitter {
    subscribe = vi.fn().mockResolvedValue('OK')
    unsubscribe = vi.fn().mockResolvedValue('OK')
    publish = vi.fn().mockResolvedValue(1)
    quit = vi.fn().mockResolvedValue('OK')
}

describe('pubsub helper (#158)', () => {
    let fakeSubscriber: FakeRedis
    let fakePublisher: FakeRedis

    beforeEach(async () => {
        await pubsub.close()
        vi.restoreAllMocks()
        fakeSubscriber = new FakeRedis()
        fakePublisher = new FakeRedis()

        let callCount = 0
        vi.spyOn(redisConnections, 'create').mockImplementation(async () => {
            callCount++
            // First call in getRedisClientSubscriber, second in getRedisClientPublisher
            return (callCount === 1 ? fakeSubscriber : fakePublisher) as never
        })
    })

    it('subscribes to a channel and routes incoming messages to listener', async () => {
        const received: string[] = []
        const listener = (msg: string) => received.push(msg)

        await pubsub.subscribe('test-channel', listener)

        expect(fakeSubscriber.subscribe).toHaveBeenCalledWith('test-channel')

        fakeSubscriber.emit('message', 'test-channel', 'hello world')

        expect(received).toEqual(['hello world'])
    })

    it('delivers messages to multiple concurrent listeners on the same channel', async () => {
        const receivedA: string[] = []
        const receivedB: string[] = []
        const listenerA = (msg: string) => receivedA.push(msg)
        const listenerB = (msg: string) => receivedB.push(msg)

        await pubsub.subscribe('shared-channel', listenerA)
        await pubsub.subscribe('shared-channel', listenerB)

        // Only subscribes to Redis once on the 0 -> 1 listener transition
        expect(fakeSubscriber.subscribe).toHaveBeenCalledTimes(1)

        fakeSubscriber.emit('message', 'shared-channel', 'event-1')

        expect(receivedA).toEqual(['event-1'])
        expect(receivedB).toEqual(['event-1'])
    })

    it('unsubscribing a single listener keeps other listeners active', async () => {
        const receivedA: string[] = []
        const receivedB: string[] = []
        const listenerA = (msg: string) => receivedA.push(msg)
        const listenerB = (msg: string) => receivedB.push(msg)

        await pubsub.subscribe('isolated-channel', listenerA)
        await pubsub.subscribe('isolated-channel', listenerB)

        await pubsub.unsubscribe('isolated-channel', listenerA)

        // Does not unsubscribe Redis channel while listenerB is still attached
        expect(fakeSubscriber.unsubscribe).not.toHaveBeenCalled()

        fakeSubscriber.emit('message', 'isolated-channel', 'event-after-a-detached')

        expect(receivedA).toEqual([])
        expect(receivedB).toEqual(['event-after-a-detached'])

        // Now detach listenerB
        await pubsub.unsubscribe('isolated-channel', listenerB)
        expect(fakeSubscriber.unsubscribe).toHaveBeenCalledWith('isolated-channel')
    })

    it('does not duplicate messages after a disconnect and reconnect cycle', async () => {
        const receivedV1: string[] = []
        const listenerV1 = (msg: string) => receivedV1.push(msg)

        // Viewer 1 connects
        await pubsub.subscribe('reconnect-channel', listenerV1)
        fakeSubscriber.emit('message', 'reconnect-channel', 'first-message')
        expect(receivedV1).toEqual(['first-message'])

        // Viewer 1 disconnects (last listener tears down channel)
        await pubsub.unsubscribe('reconnect-channel', listenerV1)
        expect(fakeSubscriber.unsubscribe).toHaveBeenCalledWith('reconnect-channel')

        // Viewer 2 connects (reconnect on same channel)
        const receivedV2: string[] = []
        const listenerV2 = (msg: string) => receivedV2.push(msg)
        await pubsub.subscribe('reconnect-channel', listenerV2)

        // Emit cross-process event
        fakeSubscriber.emit('message', 'reconnect-channel', 'second-message')

        // Crucial assertion: listenerV2 receives it EXACTLY ONCE, listenerV1 receives nothing
        expect(receivedV2).toEqual(['second-message'])
        expect(receivedV1).toEqual(['first-message'])
    })

    it('clears all listeners when unsubscribe is called without a listener reference', async () => {
        const receivedA: string[] = []
        const receivedB: string[] = []
        const listenerA = (msg: string) => receivedA.push(msg)
        const listenerB = (msg: string) => receivedB.push(msg)

        await pubsub.subscribe('clear-channel', listenerA)
        await pubsub.subscribe('clear-channel', listenerB)

        await pubsub.unsubscribe('clear-channel')

        expect(fakeSubscriber.unsubscribe).toHaveBeenCalledWith('clear-channel')

        fakeSubscriber.emit('message', 'clear-channel', 'should-be-dropped')

        expect(receivedA).toEqual([])
        expect(receivedB).toEqual([])
    })
})
