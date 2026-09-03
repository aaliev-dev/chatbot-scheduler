import * as vscode from 'vscode';
import { pickDefaultCopilotModel } from './copilot';
import { parseWhen, splitWhenAndMessage, WhenParseError } from './parser';
import { resolveDeliveryProbe } from './probe';
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
                renderScheduleList(scheduler, stream);
                return {};
            }
            if (request.command === 'cancel') {
                handleCancelCommand(request, scheduler, stream);
                return {};
            }
            if (request.command === 'deliver') {
                handleDeliverProbe(request, chatContext, scheduler, stream);
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
        stream.markdown(
            `⏰ Scheduled for **${fmtDate(s.fireAt)}**${repeatSuffix(s)}.\n\n` +
            `Message: \`${s.message.replace(/`/g, "'")}\`\n\n` +
            'Delivered into **this conversation** — even if you switch to another chat before it fires.'
        );
        pushInlineButtons(stream, s.id);
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

function renderScheduleList(scheduler: Scheduler, stream: vscode.ChatResponseStream): void {
    const all = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
    if (!all.length) {
        stream.markdown('No scheduled messages yet. Add one with `/schedule in 2h :: hello`. Or use **Chat Bot Scheduler: Schedule Message** from the Command Palette.');
        return;
    }
    stream.markdown('| # | When | Message | Delivery |\n|---|---|---|---|\n');
    all.forEach((s, i) => {
        stream.markdown(`| ${i + 1} | ${fmtDate(s.fireAt)}${repeatSuffix(s)} | \`${escapeCell(s.message)}\` | ${s.delivery} |\n`);
    });
    stream.markdown('\nCancel one with `/cancel <number>`, e.g. `/cancel 2`.');
    // A real 🗑 button per row (stream.button, feature-detected).
    type ButtonValue = { command: string; title: string; arguments?: unknown[] };
    const ctor = (vscode as unknown as Record<string, unknown>)['ChatResponseCommandButtonPart'] as
        | (new (value: ButtonValue) => object)
        | undefined;
    const buttonStream = stream as unknown as { button?: (part: object) => unknown };
    if (ctor && typeof buttonStream.button === 'function') {
        all.forEach((s, i) => {
            buttonStream.button?.(new ctor({ command: 'chatbot.removeSchedule', title: `🗑 #${i + 1}`, arguments: [s.id] }));
        });
    }
}

// --- /cancel ------------------------------------------------------------------

function handleCancelCommand(
    request: vscode.ChatRequest,
    scheduler: Scheduler,
    stream: vscode.ChatResponseStream
): void {
    const num = Number(request.prompt.trim());
    if (!Number.isInteger(num) || num < 1) {
        stream.markdown('Usage: `/cancel <number>` — the numbers are shown by `/list`.');
        return;
    }
    const sorted = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
    const target = sorted[num - 1];
    if (!target) {
        stream.markdown(`There is no schedule #${num}. Run \`/list\` to see the current numbers.`);
        return;
    }
    if (scheduler.remove(target.id)) {
        stream.markdown(`🗑 Cancelled #${num} (${fmtDate(target.fireAt)}): \`${escapeCell(target.message)}\``);
        const rest = sorted.length - 1;
        if (rest > 0) { stream.markdown(`\n${rest} schedule(s) left — re-run \`/list\` for fresh numbers.`); }
    } else {
        stream.markdown(`Could not cancel #${num} — run \`/list\` for the current state.`);
    }
}

// --- /deliver (internal delivery probe) --------------------------------------

/**
 * Checks whether the chat this probe landed in is the conversation the
 * schedule was created from: the snapshot's recent user prompts must appear,
 * in order, in the current chat history (extra turns after the schedule are
 * fine — containment, not equality).
 */
function isSameConversation(
    history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
    snapshot: SnapshotTurn[]
): boolean {
    if (!snapshot.length) { return false; }
    const current = history
        .filter((t): t is vscode.ChatRequestTurn => t instanceof vscode.ChatRequestTurn)
        .map((t) => t.prompt);
    const needles = snapshot.map((t) => t.request).slice(-3);
    let i = 0;
    for (const prompt of current) {
        if (i < needles.length && prompt === needles[i]) { i++; }
    }
    return i === needles.length;
}

function handleDeliverProbe(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    scheduler: Scheduler,
    stream: vscode.ChatResponseStream
): void {
    const id = request.prompt.trim();
    const s = scheduler.list().find((x) => x.id === id);
    if (!s || !s.history?.length) {
        resolveDeliveryProbe(id, false);
        stream.markdown('⚠️ Unknown delivery target.');
        return;
    }
    const same = isSameConversation(chatContext.history, s.history);
    resolveDeliveryProbe(id, same);
    stream.markdown(same
        ? '⏰ Scheduled message incoming right here…'
        : '⏳ This is not the target chat — opening the original conversation…');
}
// --- inline action buttons -----------------------------------------------------

/**
 * Real action buttons under a chat message.
 *
 * stream.button() + vscode.ChatResponseCommandButtonPart are newer than the
 * @types/vscode target this project compiles against, so they are accessed
 * via feature detection. Markdown `command:` links are not a fallback worth
 * rendering: the chat sanitizer strips them for non-built-in extensions
 * (that is why the first iteration of "inline buttons" was invisible).
 */
function pushInlineButtons(stream: vscode.ChatResponseStream, scheduleId: string): void {
    type ButtonValue = { command: string; title: string; arguments?: unknown[] };
    const ctor = (vscode as unknown as Record<string, unknown>)['ChatResponseCommandButtonPart'] as
        | (new (value: ButtonValue) => object)
        | undefined;
    const buttonStream = stream as unknown as { button?: (part: object) => unknown };

    const buttons: ButtonValue[] = [
        { command: 'chatbot.removeSchedule', title: '🗑 Cancel', arguments: [scheduleId] },
        { command: 'chatbot.rescheduleSchedule', title: '⏱ Change time', arguments: [scheduleId] },
    ];

    if (ctor && typeof buttonStream.button === 'function') {
        for (const value of buttons) {
            buttonStream.button(new ctor(value));
        }
    } else {
        // Very old VS Code: plain text hint instead of dead links.
        stream.markdown('\n\nManage it with `@bot /list` and `@bot /cancel`.');
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
