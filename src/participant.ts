import * as vscode from 'vscode';
import { pickDefaultCopilotModel } from './copilot';
import { parseWhen, splitWhenAndMessage, WhenParseError } from './parser';
import { findSessionBySnapshot } from './sessionFinder';
import { Scheduler } from './scheduler';
import { Schedule, SnapshotTurn } from './types';

const SYSTEM_PROMPT =
    'You are ChatBot — a concise, friendly assistant living in a VS Code extension. ' +
    'Answer in Markdown, get to the point, and prefer practical, actionable advice.';

/**
 * Registers the "@bot" participant in the NATIVE chat panel.
 * This is the "дополнить" part: the user keeps the built-in chat UX,
 * but gets an agent of their own with extra commands (/schedule, /list).
 */
export function registerChatParticipant(context: vscode.ExtensionContext, scheduler: Scheduler): void {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        try {
            if (request.command === 'schedule') {
                handleScheduleCommand(request, chatContext, scheduler, stream);
                return {};
            }
            if (request.command === 'list') {
                await renderScheduleList(context, scheduler, stream);
                return {};
            }
            if (request.command === 'cancel') {
                await handleCancelCommand(context, request, scheduler, stream);
                return {};
            }
            await handleChat(request, chatContext, stream, token);
        } catch (err) {
            stream.markdown(`⚠️ ${errorMessage(err)}`);
        }
        return {};
    };

    // Hot-swap guard: when the extension is reinstalled with --force into a
    // live window, a second instance may activate while the first one still
    // holds the participant. Losing the registration race must not kill the
    // activation — the surviving instance keeps serving @bot either way.
    try {
        const participant = vscode.chat.createChatParticipant('chatbot.scheduler', handler);
        participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'bot.svg');
        context.subscriptions.push(participant);
    } catch (err) {
        console.log(`[chatbot] createChatParticipant conflict: ${String(err)}`);
    }
}

// --- /schedule --------------------------------------------------------------

function handleScheduleCommand(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    scheduler: Scheduler,
    stream: vscode.ChatResponseStream
): void {
    const prompt = request.prompt.trim();
    if (!prompt) {
        stream.markdown(
            'Schedules a delayed message (like Telegram). When the time comes, ' +
            'the message is submitted to the chat panel automatically:\n\n' +
            '```\n/schedule in 2h :: summarize what changed in the workspace\n```\n\n' +
            '`when` accepts: `in 10m` · `in 1h 30m` · `at 17:30` · `at 17:30 tomorrow` · `daily 09:30` · ISO timestamps.\n' +
            'Short form works too: `/schedule in 2h check the TODOs`.'
        );
        return;
    }
    try {
        const { when, message } = splitWhenAndMessage(prompt);
        if (!message) { throw new WhenParseError('The message part is empty.'); }
        const parsed = parseWhen(when);
        const snapshot = buildSnapshot(chatContext.history);
        const s = scheduler.add(message, 'chat', parsed.at, parsed.repeat, snapshot);
        // Deliberately muted one-liner: this confirmation appears in the user's
        // conversation, so it must stay out of the way (no bold blocks,
        // no buttons — stream.button chips render as dead bullets in the
        // transcript). Cancellation lives in /list + /cancel.
        stream.markdown(`${fmtConfirmation(when, s.fireAt)} — “${escapeCell(s.message)}”`);
    } catch (err) {
        stream.markdown(`⚠️ ${errorMessage(err)}`);
    }
}

/**
 * Conversation snapshot at schedule time. Later, on delivery, the extension
 * searches stored chat sessions for this text to find the SAME chat again
 * (see sessionFinder). Captured from chatContext.history — everything the
 * user and agents said in this chat before the /schedule request.
 */
function buildSnapshot(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): SnapshotTurn[] | undefined {
    const turns: SnapshotTurn[] = [];
    let pending: string | undefined;
    for (const turn of history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            pending = turn.prompt;
        } else if (pending !== undefined) {
            turns.push({ request: pending, response: responseText(turn) });
            pending = undefined;
        }
    }
    if (!turns.length) { return undefined; }
    return turns.slice(-20);
}

function responseText(turn: vscode.ChatResponseTurn): string {
    return turn.response
        .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
        .join('')
        .trim();
}

// --- /list -------------------------------------------------------------------

/** Grouped view of schedules: chat label → rows (sorted by fire time). */
interface ScheduleRow {
    schedule: Schedule;
    /** In-group display number (1-based), matches /cancel. */
    num: number;
}

interface ChatGroup {
    label: string;
    rows: ScheduleRow[];
}

async function buildGroups(context: vscode.ExtensionContext, scheduler: Scheduler): Promise<ChatGroup[]> {
    const all = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
    const labeled = await Promise.all(
        all.map(async (s) => ({ s, label: await targetChatLabel(context, s) }))
    );
    const groups: ChatGroup[] = [];
    for (const e of labeled) {
        let g = groups.find((x) => x.label === e.label);
        if (!g) {
            g = { label: e.label, rows: [] };
            groups.push(g);
        }
        g.rows.push({ schedule: e.s, num: 0 });
    }
    for (const g of groups) {
        g.rows.sort((a, b) => a.schedule.fireAt - b.schedule.fireAt);
        g.rows.forEach((r, i) => { r.num = i + 1; });
    }
    return groups;
}

async function renderScheduleList(context: vscode.ExtensionContext, scheduler: Scheduler, stream: vscode.ChatResponseStream): Promise<void> {
    const groups = await buildGroups(context, scheduler);
    if (!groups.length) {
        stream.markdown('No scheduled messages yet. Add one with `/schedule in 2h :: hello`.');
        return;
    }
    for (const g of groups) {
        stream.markdown(`**${escapeCell(g.label)}**\n\n`);
        for (const r of g.rows) {
            stream.markdown(`${r.num}. ${relativePhrase(r.schedule)} “${escapeCell(r.schedule.message.slice(0, 60))}”\n`);
        }
        stream.markdown('\n');
    }
    stream.markdown('Cancel one with `/cancel <number>` (the numbers are per chat).');
}

/** "Will be sent in 15m (16:59)" style phrase, computed back from fire time. */
function relativePhrase(s: Schedule): string {
    if (s.repeat.kind === 'daily') {
        return `daily at ${pad2(s.repeat.hour)}:${pad2(s.repeat.minute)} —`;
    }
    const abs = new Date(s.fireAt);
    const at = `(${pad2(abs.getHours())}:${pad2(abs.getMinutes())})`;
    const diff = s.fireAt - Date.now();
    if (diff <= 0) { return 'Will be sent now ' + at; }
    const mins = Math.round(diff / 60000);
    if (mins < 60) { return `Will be sent in ${mins}m ${at}`; }
    const hours = Math.round(diff / 3600000);
    if (hours < 24) { return `Will be sent in ${hours}h ${at}`; }
    return `Will be sent in ${Math.round(diff / 86400000)}d ${at}`;
}

/** Human label of the chat a schedule will land in. Prefers the chat title
 *  (the one the UI shows, e.g. the workspace name), then the first prompt. */
async function targetChatLabel(context: vscode.ExtensionContext, s: Schedule): Promise<string> {
    const wsName = vscode.workspace.name ?? 'this workspace';
    if (!s.history?.length) { return wsName; }
    const found = await findSessionBySnapshot(context.storageUri, s.history);
    if (found?.title) { return found.title; }
    const firstPrompt = s.history[0].request.replace(/\s+/g, ' ').trim();
    const short = firstPrompt.length > 24 ? `${firstPrompt.slice(0, 23)}…` : firstPrompt;
    return found ? short : `(original chat deleted) ${short}`;
}

// --- /cancel ------------------------------------------------------------------

async function handleCancelCommand(
    context: vscode.ExtensionContext,
    request: vscode.ChatRequest,
    scheduler: Scheduler,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const num = Number(request.prompt.trim());
    if (!Number.isInteger(num) || num < 1) {
        stream.markdown('Usage: `/cancel <number>` — the numbers are shown by `/list`.');
        return;
    }
    // Numbers are per chat group (as displayed); if several chats have a
    // schedule with the same number, disambiguate via a quick pick.
    const groups = await buildGroups(context, scheduler);
    const candidates = groups.flatMap((g) =>
        g.rows.filter((r) => r.num === num).map((r) => ({ g, r }))
    );
    if (!candidates.length) {
        stream.markdown(`There is no schedule #${num}. Run \`/list\` to see the current numbers.`);
        return;
    }
    if (candidates.length === 1) {
        const { g, r } = candidates[0];
        scheduler.remove(r.schedule.id);
        stream.markdown(`🗑 Cancelled in “${g.label}”: ${relativePhrase(r.schedule)} “${escapeCell(r.schedule.message.slice(0, 60))}”`);
        return;
    }
    const pick = await vscode.window.showQuickPick(
        candidates.map((c) => ({
            label: `$(trash) ${c.g.label}`,
            detail: `${relativePhrase(c.r.schedule)} “${escapeCell(c.r.schedule.message.slice(0, 60))}”`,
            row: c.r,
        })),
        { placeHolder: `Both chats have a #${num} — which one to cancel?` }
    );
    if (pick) {
        scheduler.remove(pick.row.schedule.id);
        stream.markdown(`🗑 Cancelled in “${pick.label.replace('$(trash) ', '')}”.`);
    }
}

// --- plain chat --------------------------------------------------------------

async function handleChat(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    try {
        // Prefer the model the user picked in the chat dropdown, if exposed on the request.
        const fromRequest = (request as unknown as { model?: vscode.LanguageModelChat }).model;
        const model = fromRequest ?? await pickDefaultCopilotModel();

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
        ];

        // Replay a few recent turns so the agent has conversational context.
        for (const turn of chatContext.history.slice(-6)) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
                    .join('')
                    .trim();
                if (text) { messages.push(vscode.LanguageModelChatMessage.Assistant(text)); }
            }
        }

        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        const response = await model.sendRequest(messages, {}, token);
        for await (const fragment of response.text) {
            stream.markdown(fragment);
            if (token.isCancellationRequested) { return; }
        }
    } catch (err) {
        stream.markdown(`⚠️ ${errorMessage(err)}`);
    }
}

// --- helpers ------------------------------------------------------------------

function errorMessage(err: unknown): string {
    if (err instanceof vscode.LanguageModelError) {
        return `Language model error: ${err.message} (code: ${err.code ?? 'n/a'})`;
    }
    if (err instanceof WhenParseError) { return err.message; }
    return err instanceof Error ? err.message : String(err);
}

function fmtDate(t: number): string {
    return new Date(t).toLocaleString();
}

/**
 * Muted schedule confirmation: "Will be sent in 15m (16:59)" — echoes the
 * delay as commanded, with the resolved local time in parentheses.
 */
function fmtConfirmation(when: string, fireAt: number): string {
    const d = new Date(fireAt);
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `Will be sent ${when.trim()} (${time})`;
}

function repeatSuffix(s: Schedule): string {
    if (s.repeat.kind === 'daily') {
        return ` (daily at ${pad2(s.repeat.hour)}:${pad2(s.repeat.minute)})`;
    }
    return s.repeat.kind === 'none' ? '' : ' (recurring)';
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function escapeCell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/`/g, "'");
}
