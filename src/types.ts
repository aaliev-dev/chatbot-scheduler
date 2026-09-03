/**
 * How a scheduled message is delivered when its time comes.
 * - 'chat': the message is submitted into the native chat panel. It goes to
 *   the chat widget that last had focus (`lastFocusedWidget` inside VS Code)
 *   — i.e. the chat the user was working in, not a new one.
 * - 'notification': shows an information notification.
 */
export type Delivery = 'chat' | 'notification';

export type RepeatRule =
    | { kind: 'none' }
    | { kind: 'interval'; ms: number }
    | { kind: 'daily'; hour: number; minute: number };

/**
 * One turn of a conversation snapshot — the shape of `previousRequests`
 * accepted by the built-in `workbench.action.chat.open` command
 * (IChatViewOpenRequestEntry in VS Code core).
 */
export interface SnapshotTurn {
    request: string;
    response: string;
}

export interface Schedule {
    id: string;
    /** Message text. For 'chat' delivery this is submitted as a chat query. */
    message: string;
    delivery: Delivery;
    /** Epoch milliseconds when the message fires. */
    fireAt: number;
    repeat: RepeatRule;
    created: number;
    /**
     * Conversation snapshot captured from the chat where /schedule was
     * invoked. On delivery the chat is re-seeded with this history, so the
     * message lands in a continuation of the SAME conversation.
     */
    history?: SnapshotTurn[];
}
