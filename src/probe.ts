/**
 * Delivery probe — a feedback channel between the delivery flow and the
 * @bot participant.
 *
 * Theory: the extension host cannot ask "which chat does the user currently
 * look at?" — there is no API. But the participant handler RECEIVES that
 * information implicitly: when we submit `@bot /deliver <id>` through the
 * quiet chat command, it lands in the chat the user is in (lastFocused chat
 * view). The participant compares that chat's history with the target
 * conversation snapshot and answers the probe.
 */

const pending = new Map<string, (ok: boolean) => void>();

/** Resolves a pending delivery probe (called from the @bot participant). */
export function resolveDeliveryProbe(id: string, ok: boolean): void {
    const resolve = pending.get(id);
    if (resolve) {
        pending.delete(id);
        resolve(ok);
    }
}

/**
 * Waits for the participant to answer the delivery probe.
 * Resolves with `undefined` on timeout (probe never landed / handler busy).
 */
export function waitForDeliveryProbe(id: string, timeoutMs: number): Promise<boolean | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            resolve(undefined);
        }, timeoutMs);
        pending.set(id, (ok) => {
            clearTimeout(timer);
            resolve(ok);
        });
    });
}
