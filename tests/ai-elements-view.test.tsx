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
import { BroappChatView } from 'broapp-ai-elements/ui';
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
