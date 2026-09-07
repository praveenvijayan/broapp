/**
 * A conversation as plain text, for the clipboard.
 *
 * Deliberately not markdown and not JSON: what a person copies out of a chat
 * they paste into an issue, a message or a note, and the useful shape there is
 * who said what. A tool call becomes one line naming the tool, because its
 * input and output are the application's business rather than the reader's.
 */
import { isDynamicToolUIPart, isToolUIPart } from 'ai';

import type { BroappUIMessage } from '../transport.ts';

/** What one message contributes, or `null` when it says nothing. */
function lineOf(message: BroappUIMessage): string | null {
  const said: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') said.push(part.text);
    else if (part.type === 'file') said.push(`[image: ${part.filename ?? 'attachment'}]`);
    else if (isDynamicToolUIPart(part)) said.push(`Used ${part.toolName}`);
    else if (isToolUIPart(part)) said.push(`Used ${part.type.slice('tool-'.length)}`);
  }
  if (said.length === 0) return null;
  const who = message.role === 'user' ? 'You' : 'Assistant';
  return `${who}: ${said.join('\n')}`;
}

/** The whole conversation, one block per message, blank line between. */
export function transcriptOf(messages: readonly BroappUIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const line = lineOf(message);
    if (line !== null) lines.push(line);
  }
  return lines.join('\n\n');
}
