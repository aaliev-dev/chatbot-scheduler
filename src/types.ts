/**
 * How a scheduled message is delivered when its time comes.
 * - 'chat': opens the native chat panel and submits the message as a query
 *   (you can start it with an @participant, #file, etc.)
 * - 'notification': shows an information notification.
 */
export type Delivery = 'chat' | 'notification';

export type RepeatRule =
    | { kind: 'none' }
    | { kind: 'interval'; ms: number }
    | { kind: 'daily'; hour: number; minute: number };

export interface Schedule {
    id: string;
    /** Message text. For 'chat' delivery this is submitted as a chat query. */
    message: string;
    delivery: Delivery;
    /** Epoch milliseconds when the message fires. */
    fireAt: number;
    repeat: RepeatRule;
    created: number;
}
