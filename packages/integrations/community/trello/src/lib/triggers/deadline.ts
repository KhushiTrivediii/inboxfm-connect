import { trelloAuth } from '../..';
import { TriggerStrategy, createTrigger, PiecePropValueSchema, Property, AppConnectionValueForAuthProperty, Store, isNil } from '@inboxfm-connect/pieces-framework';
import { DedupeStrategy, Polling, pollingHelper } from '@inboxfm-connect/pieces-common';
import dayjs from 'dayjs';
import { trelloCommon, getCardsInBoard, getCardsInList } from '../common';

interface Props {
    board_id: string;
    list_id_opt?: string;
    time_before_due: number;
    time_unit: string;
}

/**
 * `${card.id}|${card.due}` keys of every card the trigger has already emitted,
 * kept in the piece store. The deadline trigger cannot dedupe by timestamps:
 * its events are "this card's deadline is now within the lead time", and the
 * due dates of such cards are close to `now` by definition. A timestamp cursor
 * (the shared TIMEBASED polling helper folds item epochs into `lastPoll`)
 * would forever suppress cards whose due date precedes the newest due date
 * already emitted, so we dedupe by card identity instead: each card fires once
 * per due date, the first poll that sees it inside the window.
 */
const EMITTED_CARDS_STORE_KEY = 'deadlineEmittedCardKeys';
const MAX_EMITTED_CARD_KEYS = 1000;

function cardDeadlineKey(card: { id: string; due: string }): string {
    return `${card.id}|${card.due}`;
}

async function markCardsAsEmitted(store: Store, cards: Array<{ id: string; due: string }>): Promise<void> {
    const storedKeys = await store.get<string[]>(EMITTED_CARDS_STORE_KEY);
    const keys = isNil(storedKeys) ? [] : storedKeys;
    for (const card of cards) {
        const key = cardDeadlineKey(card);
        if (!keys.includes(key)) {
            keys.push(key);
        }
    }
    await store.put(EMITTED_CARDS_STORE_KEY, keys.slice(-MAX_EMITTED_CARD_KEYS));
}

const polling: Polling<AppConnectionValueForAuthProperty<typeof trelloAuth>, Props> = {
    strategy: DedupeStrategy.TIMEBASED,
    async items({ auth, propsValue, store, lastFetchEpochMS }) {
        const { board_id, list_id_opt, time_before_due, time_unit } = propsValue;
        const getCards = list_id_opt ? getCardsInList : getCardsInBoard;
        const cards: any[] = await getCards(auth.username, auth.password, list_id_opt || board_id);

        if(lastFetchEpochMS ===0)
        {
            // If lastFetchEpochMS is 0, we assume this is the test run and return all cards with due dates
            return cards
                .filter(card => card.due && !card.dueComplete)
                .map(card => ({
                    epochMilliSeconds: dayjs(card.due).valueOf(),
                    data: card,
                }));
        }
        const now = dayjs();
        const upcoming = now.add(time_before_due, time_unit as dayjs.ManipulateType);
        const cardsInWindow = cards
            .filter(card => card.due && !card.dueComplete && dayjs(card.due).isAfter(now) && dayjs(card.due).isBefore(upcoming));

        let emittedKeys = await store.get<string[]>(EMITTED_CARDS_STORE_KEY);
        if (isNil(emittedKeys)) {
            // First poll after (re-)enable, or the first poll after upgrading
            // from the old timestamp-only dedupe (a stored `lastPoll` cursor
            // without an emitted-cards set). Seed the set with the in-window
            // cards the old `due > lastPoll` filter would have suppressed, so
            // an upgraded trigger neither re-fires already delivered cards nor
            // misses anything the old behavior would have emitted. On a fresh
            // enable the cursor is 'now', nothing is seeded, and every card in
            // the window fires, exactly like before.
            emittedKeys = cardsInWindow
                .filter(card => dayjs(card.due).valueOf() <= lastFetchEpochMS)
                .map(card => cardDeadlineKey(card));
            await store.put(EMITTED_CARDS_STORE_KEY, emittedKeys.slice(-MAX_EMITTED_CARD_KEYS));
        }
        const emitted = new Set(emittedKeys);

        return cardsInWindow
            .filter(card => !emitted.has(cardDeadlineKey(card)))
            .map(card => ({
                // Cursor-relative epoch, never the card's due date: the polling
                // helper folds item epochs into its `lastPoll` cursor and only
                // emits items with `epochMilliSeconds > lastPoll`. A due-date
                // epoch pushes that cursor into the future and permanently
                // suppresses every card created later with an earlier due
                // date. `lastFetchEpochMS + 1` always passes the helper's
                // emission filter and merely ticks the cursor forward.
                epochMilliSeconds: lastFetchEpochMS + 1,
                data: card,
            }));
    },
};

export const deadlineTrigger = createTrigger({
    auth: trelloAuth,
    name: 'deadline',
    displayName: 'Card Deadline',
    description: 'Triggers at a specified time before a card deadline.',
    aiMetadata: {
        description: 'Fires for each card whose due date falls within a configured lead time (e.g. 24 hours) ahead of now, scoped to a board or an optional list. Represents an approaching, not-yet-completed card deadline; polls periodically and skips cards already marked due-complete.',
    },
    type: TriggerStrategy.POLLING,
    props: {
        board_id: trelloCommon.board_id,
        list_id_opt: trelloCommon.list_id_opt,
        time_unit: Property.StaticDropdown({
            displayName: 'Time unit',
            description: 'Select unit for time before due',
            required: true,
            options: {
            options: [
                { label: 'Minutes', value: 'minutes' },
                { label: 'Hours', value: 'hours' },
            ],
            },
            defaultValue: 'hours',
        }),
        time_before_due: Property.Number({
            displayName: 'Time before due',
            description: 'How long before the due date the trigger should run (use with time unit)',
            required: true,
            defaultValue: 24,
        }),
    },
    async onEnable(context) {
        // Start from a clean dedupe set on (re-)enable, matching the implicit
        // cursor reset of the previous implementation.
        await context.store.delete(EMITTED_CARDS_STORE_KEY);
        await pollingHelper.onEnable(polling, context);
    },
    async onDisable(context) {
        await pollingHelper.onDisable(polling, context);
    },
    async run(context) {
        const emittedCards = (await pollingHelper.poll(polling, context)) as Array<{
            id: string;
            due: string;
        }>;
        if (emittedCards.length > 0) {
            // Record the emitted cards only after the poll succeeded: marking
            // them inside items() could silently drop a deadline alert forever
            // if the poll failed between marking and emitting, while marking
            // here can at worst re-deliver an alert on the next poll.
            await markCardsAsEmitted(context.store, emittedCards);
        }
        return emittedCards;
    },
    async test(context) {
        return await pollingHelper.test(polling, context);
    },
    sampleData: undefined,
});