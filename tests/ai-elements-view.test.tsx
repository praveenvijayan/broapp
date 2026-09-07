/**
 * What the panel renders, without a DOM.
 *
 * `renderToString` is enough for the questions that matter here: markdown is
 * inert, an approval card says how long is left, and a denied call is labelled
 * as one. Nothing is clicked; that is prompt 04's manual run.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import type { ToolUIPart } from 'ai';
import { aiContract } from 'broapp/ai';
import { AiProvider } from 'broapp/ai/react';
import { BroappProvider } from 'broapp/react';
import { BroappChatDrawer, BroappChatToggle, BroappChatView, transcriptOf } from 'broapp-ai-elements/ui';
import type { BroappUIMessage } from 'broapp-ai-elements';

const NOW = 1_700_000_000_000;

/**
 * The view with everything at rest, plus whatever a case overrides.
 *
 * React writes `<!-- -->` between two adjacent text nodes so it can find the
 * boundary again when it hydrates. It is invisible to a reader, so it is
 * removed here rather than written into every expectation.
 */
function render(overrides: Partial<Parameters<typeof BroappChatView>[0]> = {}): string {
  return renderToString(
    <BroappChatView
      emptyText="Ask a question about what you are looking at."
      error={null}
      markdown
      messages={[]}
      now={NOW}
      onConfirm={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      placeholder="Ask about these notes"
      status="ready"
      usage={null}
      {...overrides}
    />,
  ).replaceAll('<!-- -->', '');
}

function assistant(text: string): BroappUIMessage {
  return { id: 'm1', role: 'assistant', parts: [{ type: 'text', text }] };
}

/** One tool part, in whichever state a case needs. */
function toolMessage(part: ToolUIPart): BroappUIMessage {
  return { id: 'm1', role: 'assistant', parts: [part] };
}

const HOSTILE =
  '**bold** [link](https://evil.example) ![img](https://evil.example/x.png) <script>alert(1)</script> `code`';

describe('markdown', () => {
  test('renders emphasis but never a link, an image or markup', () => {
    const html = render({ messages: [assistant(HOSTILE)] });

    // streamdown 2.6.0 renders strong emphasis as a marked span rather than
    // `<strong>`; what matters is that the emphasis survived.
    expect(html).toContain('data-streamdown="strong">bold</span>');
    // The words of a link survive; the link does not.
    expect(html).toContain('link');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    // `skipHtml` drops embedded markup whole rather than escaping it, so the
    // script element and its contents both go.
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert(1)');
    // Inline code is still code.
    expect(html).toContain('>code</code>');
  });

  test('is off for a person&apos;s own words', () => {
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: '**mine**' }],
    };
    const html = render({ messages: [message] });

    expect(html).not.toContain('<strong>');
    expect(html).toContain('**mine**');
  });

  test('is off everywhere when markdown is off', () => {
    const html = render({ markdown: false, messages: [assistant(HOSTILE)] });

    expect(html).toContain('<pre');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the approval card', () => {
  const pending = (expiresAt: number): ToolUIPart => ({
    type: 'tool-notes.create',
    toolCallId: 'call-1',
    state: 'approval-requested',
    input: { title: 'New' },
    approval: { id: 'req-1', descriptor: { tool: 'notes.create', expiresAt } },
  });

  test('asks, and says how long is left', () => {
    const html = render({ messages: [toolMessage(pending(NOW + 9 * 60_000 + 35_000))] });

    expect(html).toContain('Allow this?');
    expect(html).toContain('expires in 9:35');
    expect(html).toContain('Allow');
    expect(html).toContain('Decline');
    expect(html).toContain('aria-label="Allow notes.create?"');
    expect(html).not.toContain('broapp-chat__confirm--urgent');
  });

  test('turns urgent under a minute', () => {
    const html = render({ messages: [toolMessage(pending(NOW + 30_000))] });

    expect(html).toContain('broapp-chat__confirm--urgent');
    expect(html).toContain('expires in 0:30');
  });

  test('is gone once the call is settled, and a refusal says so', () => {
    const denied: ToolUIPart = {
      type: 'tool-notes.create',
      toolCallId: 'call-1',
      state: 'output-denied',
      input: { title: 'New' },
    };
    const html = render({ messages: [toolMessage(denied)] });

    expect(html).toContain('Declined notes.create');
    expect(html).not.toContain('Allow this?');
  });
});

describe('the rest of the panel', () => {
  test('shows the empty state before anything is said', () => {
    expect(render()).toContain('Ask a question about what you are looking at.');
  });

  test('shows the usage line', () => {
    const html = render({
      messages: [assistant('done')],
      usage: { inputTokens: 1424, outputTokens: 108 },
    });
    expect(html).toContain('1424 tokens in, 108 out');
  });

  test('shows an error as an alert', () => {
    const html = render({ error: 'That request has expired.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('That request has expired.');
  });

  test('shows an attached image from its data URL', () => {
    const message: BroappUIMessage = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'file',
          mediaType: 'image/png',
          filename: 'shot.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ],
    };
    const html = render({ messages: [message] });

    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('alt="shot.png"');
  });

  test('carries the placeholder into the box', () => {
    expect(render()).toContain('Ask about these notes');
  });
});

describe('suggestions', () => {
  const three = ['What applications do I have?', 'Add a field to notes', 'Show me the last run'];

  test('are offered while nothing has been said, each as a button', () => {
    const html = render({ suggestions: three, suggestionTip: 'Tip: you can open and close chat with \u2318 I' });

    for (const suggestion of three) expect(html).toContain(`>${suggestion}</button>`);
    expect(html).toContain('Tip: you can open and close chat with \u2318 I');
  });

  test('are gone once the conversation has started', () => {
    const html = render({ messages: [assistant('hello')], suggestions: three });

    expect(html).not.toContain(three[0] ?? '');
  });

  test('carry no tip when there is no shortcut', () => {
    const html = render({ suggestions: three });

    expect(html).toContain(three[0] ?? '');
    expect(html).not.toContain('Tip:');
  });
});

describe('the character counter', () => {
  test("starts at nothing, out of the contract's cap", () => {
    expect(render()).toContain('0 / 20000');
  });

  test('counts against whatever cap the caller set', () => {
    const html = render({ maxLength: 1000 });

    expect(html).toContain('0 / 1000');
    expect(html).toContain('maxLength="1000"');
  });
});

describe('the drawer', () => {
  /**
   * The drawer, inside the providers `BroappChat` needs.
   *
   * `renderToString` runs no effects, so no connection is opened and the AI
   * settings are never fetched: the chat below the header renders its
   * "checking" state. The header, the aside and the shortcut are what this
   * file can see, and they are what these cases are about.
   */
  function drawer(overrides: Partial<Parameters<typeof BroappChatDrawer>[0]> = {}): string {
    return renderToString(
      <BroappProvider contract={aiContract}>
        <AiProvider>
          <BroappChatDrawer onOpenChange={() => undefined} open title="Engineer" {...overrides} />
        </AiProvider>
      </BroappProvider>,
    ).replaceAll('<!-- -->', '');
  }

  test('is hidden when closed and shown when open', () => {
    expect(drawer({ open: false })).toContain('hidden=""');
    expect(drawer()).not.toContain('hidden=""');
  });

  test('names itself, and offers the three header actions', () => {
    const html = drawer();

    expect(html).toContain('aria-label="Engineer"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-label="Copy transcript"');
    expect(html).toContain('aria-label="Clear conversation"');
    expect(html).toContain('aria-label="Close"');
  });

  test('shows the description it was given', () => {
    const html = drawer({ description: 'Ask for a change to notes.' });

    expect(html).toContain('Ask for a change to notes.');
  });

  test('takes its width from a custom property, so a narrow window can win', () => {
    expect(drawer({ width: '30rem' })).toContain('--broapp-chat-drawer-width:30rem');
  });
});

describe('the toggle', () => {
  test('says whether the drawer is open, and how to open it', () => {
    const html = renderToString(<BroappChatToggle onToggle={() => undefined} open />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<kbd>\u2318 I</kbd>');
    expect(html).toContain('Ask AI');
  });

  test('shows no key when there is no shortcut', () => {
    const html = renderToString(
      <BroappChatToggle onToggle={() => undefined} open={false} shortcutKey={null} />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('<kbd>');
  });
});

describe('the transcript', () => {
  test('is who said what, with a line for each tool call', () => {
    const tool: ToolUIPart = {
      type: 'tool-notes.create',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { title: 'New' },
      output: { id: 'n1' },
    };
    const text = transcriptOf([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'add a note' }] },
      { id: 'm2', role: 'assistant', parts: [tool, { type: 'text', text: 'Added it.' }] },
    ]);

    expect(text).toBe('You: add a note\n\nAssistant: Used notes.create\nAdded it.');
  });
});
