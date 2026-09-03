import { RepeatRule } from './types';

/** Result of parsing a user-supplied "when" expression. */
export interface ParsedWhen {
    at: number;
    repeat: RepeatRule;
}

export class WhenParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WhenParseError';
    }
}

const USAGE =
    'Unable to parse the time. Supported formats:\n' +
    '• "15m" / "2h" / "1h 30m" / "2d" — delayed (Telegram-style)\n' +
    '• "in 2h" / "in 1h 30m" — same with the explicit keyword\n' +
    '• "at 17:30" / "at 5:30pm" / "at 17:30 tomorrow"\n' +
    '• "at 2026-09-05 10:00"\n' +
    '• "daily 09:30" — recurring every day\n' +
    '• ISO timestamp, e.g. "2026-09-05T10:00:00"';

const UNIT_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

// One duration token: number + unit, e.g. "2h", "30m", "1.5d".
const DURATION_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/g;

function normalizeUnit(unit: string): number | undefined {
    const u = unit.toLowerCase();
    if (u.startsWith('s')) { return UNIT_MS.s; }
    if (u.startsWith('m')) { return UNIT_MS.m; }
    if (u.startsWith('h')) { return UNIT_MS.h; }
    if (u.startsWith('d')) { return UNIT_MS.d; }
    return undefined;
}

/**
 * Parses a run of duration tokens ("1h 30m"). Returns the total milliseconds,
 * or -1 if the text is not purely durations.
 */
function parseDuration(text: string): number {
    let total = 0;
    let matched = false;
    for (const m of text.matchAll(DURATION_TOKEN_RE)) {
        const unitMs = normalizeUnit(m[2]);
        if (unitMs === undefined) { return -1; }
        total += parseFloat(m[1]) * unitMs;
        matched = true;
    }
    const leftover = text.replace(DURATION_TOKEN_RE, '').replace(/[\s,]/g, '');
    if (leftover || !matched) { return -1; }
    return total;
}

function assertClock(hour: number, minute: number): void {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new WhenParseError(`Invalid time of day "${hour}:${minute}".`);
    }
}

/** Next future moment matching hour:minute, on or after baseMs. */
function nextDailyAt(hour: number, minute: number, baseMs: number): number {
    const d = new Date(baseMs);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= baseMs) { d.setDate(d.getDate() + 1); }
    return d.getTime();
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * Parses a "when" expression into an absolute timestamp + repeat rule.
 *
 * Grammar (case-insensitive):
 *   in <duration>            → delay from now, e.g. "in 2h", "in 1h 30m"
 *   daily HH:MM              → recurring every day at a fixed time
 *   at HH:MM [am|pm] [tomorrow]
 *   at YYYY-MM-DD HH:MM      → exact date and time
 *   <anything Date.parse understands> (ISO, RFC) as fallback
 */
export function parseWhen(raw: string, now: Date = new Date()): ParsedWhen {
    const input = raw.trim().toLowerCase();
    const nowMs = now.getTime();
    if (!input) { throw new WhenParseError(USAGE); }

    // 0) Bare duration without the "in" keyword: "15m", "1h 30m", "2d".
    const bare = parseDuration(input);
    if (bare > 0) { return { at: nowMs + bare, repeat: { kind: 'none' } }; }

    // 1) Delayed sending — the main use case ("send this in 2 hours").
    const rel = input.match(/^(?:in|after|через)\s+(.+)$/);
    if (rel) {
        const ms = parseDuration(rel[1]);
        if (ms > 0) { return { at: nowMs + ms, repeat: { kind: 'none' } }; }
        throw new WhenParseError(`Could not read the delay "${rel[1]}".\n${USAGE}`);
    }

    // 2) Recurring daily.
    const daily = input.match(/^(?:daily|every day|each day|каждый день)\s+(\d{1,2}):(\d{2})$/);
    if (daily) {
        const hour = Number(daily[1]);
        const minute = Number(daily[2]);
        assertClock(hour, minute);
        return { at: nextDailyAt(hour, minute, nowMs), repeat: { kind: 'daily', hour, minute } };
    }

    // 3) "at ..." forms.
    const at = input.match(/^(?:at|@|на|в)\s+(.+)$/);
    if (at) {
        const rest = at[1].trim();

        // 3a) Full date + time: "2026-09-05 10:00".
        const iso = rest.match(/^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}):(\d{2})$/);
        if (iso) {
            const hour = Number(iso[2]);
            const minute = Number(iso[3]);
            assertClock(hour, minute);
            const t = new Date(`${iso[1]}T${pad(hour)}:${pad(minute)}:00`).getTime();
            if (Number.isNaN(t)) { throw new WhenParseError(`Invalid date "${raw}".`); }
            if (t <= nowMs) { throw new WhenParseError(`"${raw}" is already in the past.`); }
            return { at: t, repeat: { kind: 'none' } };
        }

        // 3b) Time of day, optionally am/pm and/or tomorrow.
        const tm = rest.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(tomorrow|завтра|с завтра)?$/);
        if (tm) {
            let hour = Number(tm[1]);
            const minute = Number(tm[2] ?? '0');
            assertClock(hour, minute);
            if (tm[3] === 'pm' && hour < 12) { hour += 12; }
            if (tm[3] === 'am' && hour === 12) { hour = 0; }
            const tomorrow = Boolean(tm[4]);
            const d = new Date(now);
            d.setHours(hour, minute, 0, 0);
            if (tomorrow) { d.setDate(d.getDate() + 1); }
            else if (d.getTime() <= nowMs) { d.setDate(d.getDate() + 1); } // today's slot already passed → tomorrow
            return { at: d.getTime(), repeat: { kind: 'none' } };
        }

        throw new WhenParseError(`Could not read the time from "${raw}".\n${USAGE}`);
    }

    // 4) Fallback: anything Date.parse understands (ISO etc.).
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) {
        if (t <= nowMs) { throw new WhenParseError(`"${raw}" is already in the past.`); }
        return { at: t, repeat: { kind: 'none' } };
    }

    throw new WhenParseError(USAGE);
}

/**
 * Splits a `/schedule <prompt>` into "when" and "message" parts.
 *
 * Two syntaxes:
 *   "<when> :: <message>"   — explicit separator, always tried first
 *   "<when> <message>"     — natural: greedily test growing prefixes until
 *                            one parses as a valid "when"; the rest is message
 */
export function splitWhenAndMessage(prompt: string): { when: string; message: string } {
    const text = prompt.trim();

    const sep = text.indexOf('::');
    if (sep >= 0) {
        const when = text.slice(0, sep).trim();
        const message = text.slice(sep + 2).trim();
        parseWhen(when); // validate eagerly → clear error instead of a weird split
        return { when, message };
    }

    const tokens = text.split(/\s+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
        const candidate = tokens.slice(0, i).join(' ');
        try {
            parseWhen(candidate);
            return { when: candidate, message: tokens.slice(i).join(' ') };
        } catch {
            // extend the candidate by one more token and retry
        }
    }

    throw new WhenParseError(
        'Could not split the request into "when" and "message".\n' +
        'Tip: use the explicit form `/schedule in 2h :: your message here`.'
    );
}
