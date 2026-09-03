import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { Delivery, RepeatRule, Schedule, SnapshotTurn } from './types';

const STORAGE_KEY = 'chatbot.schedules';

// setTimeout() overflows beyond 2^31-1 ms (~24.8 days) — so long delays are
// clamped and re-armed when the clamped timer wakes up "too early".
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Persistent, catch-up-safe message scheduler.
 *
 * Theory — why it is built this way:
 *
 * 1. The extension host is a Node process that lives only while a VS Code
 *    window is open. Plain timers therefore die on reload/close, so all
 *    schedules are persisted in globalState (JSON in the user profile) and
 *    re-armed on every activation.
 *
 * 2. A one-shot schedule that became due while VS Code was closed is NOT
 *    dropped: it fires immediately on the next activation (like a queued
 *    Telegram message going out once you are back online).
 *
 * 3. Background windows throttle timers, so when the window regains focus we
 *    run {@link checkDue} to catch anything that fell behind.
 *
 * 4. setTimeout cannot span more than ~24.8 days at once, so long delays are
 *    clamped and re-armed on the intermediate wake-up.
 */
export class Scheduler implements vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly _onFire = new vscode.EventEmitter<Schedule>();
    readonly onFire = this._onFire.event;

    private readonly timers = new Map<string, NodeJS.Timeout>();
    private schedules: Schedule[] = [];

    constructor(private readonly storage: vscode.Memento) {
        this.schedules = storage.get<Schedule[]>(STORAGE_KEY, []) ?? [];
        this.restore();
    }

    list(): readonly Schedule[] {
        return this.schedules;
    }

    add(
        message: string,
        delivery: Delivery,
        fireAt: number,
        repeat: RepeatRule = { kind: 'none' },
        history?: SnapshotTurn[]
    ): Schedule {
        const schedule: Schedule = {
            id: randomUUID(),
            message,
            delivery,
            fireAt,
            repeat,
            created: Date.now(),
            history,
        };
        this.schedules.push(schedule);
        this.arm(schedule);
        this.persist();
        return schedule;
    }

    remove(id: string): boolean {
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
        const before = this.schedules.length;
        this.schedules = this.schedules.filter((s) => s.id !== id);
        if (this.schedules.length === before) { return false; }
        this.persist();
        return true;
    }

    /** Moves a schedule to a new fire time (and optionally a new repeat rule). */
    reschedule(id: string, fireAt: number, repeat: RepeatRule): boolean {
        const s = this.schedules.find((x) => x.id === id);
        if (!s) { return false; }
        s.fireAt = fireAt;
        s.repeat = repeat;
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
        this.arm(s);
        this.persist();
        return true;
    }

    /** Fires anything that became due while the window was unfocused/throttled. */
    checkDue(): void {
        const now = Date.now();
        for (const s of [...this.schedules]) {
            if (s.fireAt <= now) {
                const timer = this.timers.get(s.id);
                if (timer) {
                    clearTimeout(timer);
                    this.timers.delete(s.id);
                }
                this.handleFire(s.id);
            }
        }
    }

    dispose(): void {
        for (const t of this.timers.values()) { clearTimeout(t); }
        this.timers.clear();
        this._onDidChange.dispose();
        this._onFire.dispose();
    }

    // --- internals -----------------------------------------------------------

    /** Rebuilds timers from persisted state; called once from the constructor. */
    private restore(): void {
        const now = Date.now();
        for (const s of this.schedules) {
            if (s.fireAt > now) {
                this.arm(s);
            } else if (s.repeat.kind !== 'none') {
                // Recurring schedule missed one or more runs → jump to the next
                // future occurrence (no backfill spam).
                s.fireAt = this.advanceIntoFuture(s.repeat, s.fireAt, now);
                this.arm(s);
            } else {
                // One-shot that became due while VS Code was closed → deliver
                // now, on activation.
                const t = setTimeout(() => this.handleFire(s.id), 0);
                this.timers.set(s.id, t);
            }
        }
        this.persist(); // persist possible fireAt adjustments from recurring rules
    }

    private arm(s: Schedule): void {
        const delay = Math.max(0, s.fireAt - Date.now());
        const t = setTimeout(() => this.handleFire(s.id), Math.min(delay, MAX_TIMEOUT_MS));
        this.timers.set(s.id, t);
    }

    private handleFire(id: string): void {
        this.timers.delete(id);
        const s = this.schedules.find((x) => x.id === id);
        if (!s) { return; }

        if (s.fireAt - Date.now() > 2_000) {
            // Timer woke early (clamped long delay) → re-arm, do not fire yet.
            this.arm(s);
            return;
        }
        this.fire(s);
    }

    private fire(s: Schedule): void {
        // Emit a snapshot: deliver before mutating for the repeat cycle.
        try {
            this._onFire.fire({ ...s });
        } finally {
            if (s.repeat.kind === 'none') {
                this.schedules = this.schedules.filter((x) => x.id !== s.id);
                this.timers.delete(s.id);
            } else {
                s.fireAt = this.nextOccurrence(s.repeat, s.fireAt);
                this.arm(s);
            }
            this.persist();
        }
    }

    private advanceIntoFuture(rule: RepeatRule, from: number, now: number): number {
        if (rule.kind === 'interval') {
            const steps = Math.max(1, Math.ceil((now - from) / rule.ms));
            return from + steps * rule.ms;
        }
        if (rule.kind === 'daily') {
            const d = new Date(now);
            d.setHours(rule.hour, rule.minute, 0, 0);
            while (d.getTime() <= now) { d.setDate(d.getDate() + 1); }
            return d.getTime();
        }
        return from;
    }

    private nextOccurrence(rule: RepeatRule, from: number): number {
        if (rule.kind === 'interval') { return from + rule.ms; }
        if (rule.kind === 'daily') {
            const d = new Date(from);
            d.setHours(rule.hour, rule.minute, 0, 0);
            if (d.getTime() <= from) { d.setDate(d.getDate() + 1); }
            return d.getTime();
        }
        return from;
    }

    private persist(): void {
        void this.storage.update(STORAGE_KEY, this.schedules);
        this._onDidChange.fire();
    }
}
