import * as vscode from 'vscode';

/**
 * Picks a default Copilot language model.
 * Throwing (rather than returning undefined) keeps call sites simple: the
 * model might be unavailable because Copilot is signed out, disabled, or
 * the user never consented to local LM access.
 */
export async function pickDefaultCopilotModel(): Promise<vscode.LanguageModelChat> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
        throw new Error(
            'No Copilot models available. Make sure GitHub Copilot is installed, ' +
            'you are signed in, and you have granted the extension access to language models.'
        );
    }
    return models[0];
}
