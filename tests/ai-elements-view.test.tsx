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
import {
  BroappChatDrawer,
  BroappChatMenu,
  BroappChatToggle,
  BroappChatView,
  BroappModelList,
  BroappModelPicker,
  groupHeading,
  moveLine,
  BroappSchemeToggle,
  BroappThreadList,
  STATUS_LINE_MS,
  formatElapsed,
  grantThenAllow,
  statusLine,
  transcriptOf,
} from 'broapp-ai-elements/ui';
import type { BroappModel, Thread } from 'broapp/ai';
import { unavailableLine } from 'broapp/ai';
import { BroappError } from 'broapp/shared';
import { modelsReducer, NO_MODELS } from '../packages/broapp/src/ai/react/use-ai-models.ts';
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

describe('the running mark', () => {
  const call = (state: ToolUIPart['state']): ToolUIPart =>
    ({
      type: 'tool-source.read',
      toolCallId: 'call-1',
      state,
      input: { path: 'src/shared/views.ts' },
      ...(state === 'output-available' ? { output: { text: '…' } } : {}),
    }) as ToolUIPart;

  test('shows before anything has arrived', () => {
    const html = render({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Add tags' }] }],
      status: 'submitted',
    });

    expect(html).toContain('broapp-chat__loader');
    expect(html).toContain('Still working.');
    expect(html).toContain('Thinking…');
  });

  test('stays between tool calls, counting them, once text has arrived', () => {
    const html = render({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Reading first.', state: 'done' }, call('output-available'), call('output-available')],
        },
      ],
      status: 'streaming',
    });

    expect(html).toContain('broapp-chat__loader');
    expect(html).toContain('2 tool calls');
    expect(html).not.toContain('Running ');
  });

  test('names the tool whose result has not come back', () => {
    const html = render({
      messages: [{ id: 'm1', role: 'assistant', parts: [call('output-available'), call('input-available')] }],
      status: 'streaming',
    });

    expect(html).toContain('Running source.read…');
    expect(html).toContain('2 tool calls');
  });

  test('is gone while words are streaming, while a call waits on the person, and at rest', () => {
    const streaming = render({
      messages: [{ id: 'm1', role: 'assistant', parts: [call('output-available'), { type: 'text', text: 'Done', state: 'streaming' }] }],
      status: 'streaming',
    });
    expect(streaming).not.toContain('broapp-chat__loader');

    const waiting = render({
      messages: [
        toolMessage({
          type: 'tool-notes.create',
          toolCallId: 'call-2',
          state: 'approval-requested',
          input: {},
          approval: { id: 'req-1', descriptor: { tool: 'notes.create', expiresAt: NOW + 60_000 } },
        }),
      ],
      status: 'streaming',
    });
    expect(waiting).not.toContain('broapp-chat__loader');
    expect(waiting).toContain('Allow this?');

    expect(render({ messages: [assistant('Done.')], status: 'ready' })).not.toContain('broapp-chat__loader');
  });

  test('takes the phrases it is given', () => {
    const html = render({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Go' }] }],
      status: 'submitted',
      statusLines: ['Mocking…', 'Surviving…'],
    });

    expect(html).toContain('Mocking…');
    expect(html).not.toContain('Thinking…');
  });
});

describe('the mark’s helpers', () => {
  test('format the elapsed time and walk the phrases on a four-second tick', () => {
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    const lines = ['a', 'b', 'c'];
    // Start offset from the start time, then one step every STATUS_LINE_MS.
    const start = 7_000; // 7 % 3 = 1
    expect(statusLine(lines, 0, start)).toBe('b');
    expect(statusLine(lines, STATUS_LINE_MS, start)).toBe('c');
    expect(statusLine(lines, 2 * STATUS_LINE_MS, start)).toBe('a');
    expect(statusLine(lines, null, null)).toBe('a');
    expect(statusLine([], 0, null)).toBe('');
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

describe('20a: a third answer on the approval card', () => {
  const pending: ToolUIPart = {
    type: 'tool-candidate.cycle',
    toolCallId: 'call-1',
    state: 'approval-requested',
    input: { appId: 'items', hunks: [] },
    // A step of the call: the descriptor names the step.
    approval: { id: 'req-1', descriptor: { tool: 'candidate.build', expiresAt: NOW + 60_000 } },
  };
  const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? '');

  test('no third button without the prop, or when it offers nothing', () => {
    const without = render({ messages: [toolMessage(pending)] });
    expect(buttons(without).filter((label) => ['Allow', 'Decline', 'Allow, and stop asking'].includes(label))).toEqual(['Allow', 'Decline']);
    const asked: unknown[] = [];
    const none = render({
      messages: [toolMessage(pending)],
      standing: (call) => {
        asked.push(call);
        return null;
      },
    });
    expect(buttons(none)).not.toContain('Allow, and stop asking');
    // Asked about the step the card is about, with the call's own input.
    expect(asked).toEqual([{ callId: 'call-1', tool: 'candidate.build', input: { appId: 'items', hunks: [] } }]);
  });

  test('with an offer, its label between Allow and Decline', () => {
    const html = render({
      messages: [toolMessage(pending)],
      standing: () => ({ label: 'Allow, and stop asking', grant: () => Promise.resolve() }),
    });
    const labels = buttons(html).filter((label) => ['Allow', 'Decline', 'Allow, and stop asking'].includes(label));
    expect(labels).toEqual(['Allow', 'Allow, and stop asking', 'Decline']);
  });

  test('clicking awaits grant(), then answers the question yes', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const granted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const offer = {
      label: 'Allow, and stop asking',
      grant: async () => {
        order.push('grant');
        await granted;
        order.push('granted');
      },
    };
    const click = grantThenAllow(offer, 'call-1', (callId, approve) => order.push(`confirm ${callId} ${String(approve)}`), (message) =>
      order.push(`error ${message}`),
    );
    await Bun.sleep(5);
    // Nothing is answered while the standing answer is being recorded.
    expect(order).toEqual(['grant']);
    release();
    expect(await click).toBe(true);
    expect(order).toEqual(['grant', 'granted', 'confirm call-1 true']);
  });

  test('a grant() that rejects shows its message and answers nothing', async () => {
    const confirmed: unknown[] = [];
    const errors: string[] = [];
    const ok = await grantThenAllow(
      { label: 'Allow, and stop asking', grant: () => Promise.reject(new Error('The switch could not be saved.')) },
      'call-1',
      (callId, approve) => confirmed.push([callId, approve]),
      (message) => errors.push(message),
    );
    expect(ok).toBe(false);
    expect(confirmed).toEqual([]);
    expect(errors).toEqual(['The switch could not be saved.']);
    // The card is still there, both buttons with it, and the message shows where a failed answer does.
    const html = render({
      messages: [toolMessage(pending)],
      error: errors[0] ?? null,
      standing: () => ({ label: 'Allow, and stop asking', grant: () => Promise.reject(new Error('no')) }),
    });
    expect(html).toContain('Allow this?');
    expect(buttons(html)).toContain('Allow');
    expect(buttons(html)).toContain('Decline');
    expect(html).toContain('The switch could not be saved.');
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
    // Bun's `navigator.platform` is the host's, so this reads ⌘ on a Mac and
    // Ctrl on the Linux runner. Either is right; what matters is the key.
    expect(html).toMatch(/<kbd>(\u2318|Ctrl) I<\/kbd>/);
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

describe('the model picker', () => {
  const models: BroappModel[] = [
    {
      provider: 'ollama',
      modelId: 'gemma4:31b-mlx',
      label: 'gemma4:31b-mlx',
      capabilities: { tools: true, vision: true, structuredOutput: false },
    },
    {
      provider: 'ollama',
      modelId: 'nirnex-model:latest',
      label: 'nirnex-model:latest',
      capabilities: { tools: true, vision: false, structuredOutput: false },
    },
  ];

  test('shows what the conversation follows, closed', () => {
    // No connection is opened under `renderToString`, so the hook has no
    // models yet: the trigger falls back to the id Settings would use, which
    // here is nothing at all.
    const html = renderToString(
      <BroappProvider contract={aiContract}>
        <AiProvider>
          <BroappModelPicker onChange={() => undefined} value={null} />
        </AiProvider>
      </BroappProvider>,
    ).replaceAll('<!-- -->', '');

    expect(html).toContain('Default · not set');
    // Closed: the list, and the badges in it, are not in the document.
    expect(html).not.toContain('vision');
  });

  test('marks the vision models and the current one', () => {
    const html = renderToString(
      <BroappModelList
        activeProvider="ollama"
        defaultLabel="gemma4:31b-mlx"
        models={models}
        onChange={() => undefined}
        value="nirnex-model:latest"
      />,
    ).replaceAll('<!-- -->', '');

    // One badge, for the one model that reports it.
    expect(html.split('>vision<').length - 1).toBe(1);
    expect(html).toContain('Default (follow Settings)');
    expect(html).toContain('gemma4:31b-mlx');
    // The check is on the pinned model, not on the default row.
    expect(html.split('aria-label="Current"').length - 1).toBe(1);
  });
});

describe('18b: the picker groups every provider and says where each runs', () => {
  const both: BroappModel[] = [
    { provider: 'ollama', modelId: 'qwen3:27b', label: 'qwen3:27b', capabilities: { tools: true, vision: false, structuredOutput: false } },
    { provider: 'openrouter', modelId: 'anthropic/claude-opus-5', label: 'Claude Opus 5', capabilities: { tools: true, vision: true, structuredOutput: false } },
  ];
  const providers = [
    { id: 'ollama', label: 'Ollama (local)', local: true },
    { id: 'openrouter', label: 'OpenRouter', local: false },
  ];

  test('two groups with their headings, in the build’s order, and the default row says where Settings runs', () => {
    const html = renderToString(
      <BroappModelList
        activeProvider="ollama"
        defaultLabel="qwen3:27b"
        defaultWhere="on this computer"
        models={[...both].reverse()}
        onChange={() => undefined}
        providers={providers}
        unavailable={[{ provider: 'openai', message: 'Could not reach OpenAI.' }]}
        value={null}
      />,
    ).replaceAll('<!-- -->', '');
    const first = html.indexOf('Ollama (local) — on this computer');
    const second = html.indexOf('OpenRouter — sent to OpenRouter');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain('qwen3:27b · on this computer');
    // A provider that could not be read costs a line under the list, not the list.
    expect(html).toContain('Could not reach OpenAI.');
  });

  test('a stored bare reference shows as the model of the provider in use', () => {
    const html = renderToString(
      <BroappModelList activeProvider="ollama" defaultLabel="x" models={both} onChange={() => undefined} providers={providers} value="qwen3:27b" />,
    ).replaceAll('<!-- -->', '');
    expect(html.split('aria-label="Current"').length - 1).toBe(1);
    // The check sits in the Ollama group, after its heading and before OpenRouter's.
    const check = html.indexOf('aria-label="Current"');
    expect(check).toBeGreaterThan(html.indexOf('Ollama (local) — on this computer'));
    expect(check).toBeLessThan(html.indexOf('OpenRouter — sent to OpenRouter'));
  });

  test('moving a conversation off this computer, or back, earns one line; staying put earns none', () => {
    expect(moveLine(true, false, 'OpenRouter')).toBe('From the next message, this conversation is sent to OpenRouter.');
    expect(moveLine(false, true, 'Ollama (local)')).toBe('From the next message, this conversation stays on this computer.');
    expect(moveLine(true, true, 'Ollama (local)')).toBeNull();
    expect(moveLine(null, false, 'OpenRouter')).toBeNull();
  });
});

describe('the conversation list', () => {
  const NOON = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const threads: Thread[] = [
    {
      id: 't1',
      title: 'Add a field to notes',
      modelId: 'gemma4:31b-mlx',
      createdAt: NOON - 3_600_000,
      updatedAt: NOON - 3_600_000,
      messageCount: 4,
    },
    {
      id: 't2',
      title: 'What changed last week',
      modelId: null,
      createdAt: NOON - 6 * 86_400_000,
      updatedAt: NOON - 6 * 86_400_000,
      messageCount: 2,
    },
  ];

  function list(overrides: Partial<Parameters<typeof BroappThreadList>[0]> = {}): string {
    return renderToString(
      <BroappThreadList
        activeId="t1"
        now={NOON}
        onDelete={() => undefined}
        onNew={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        threads={threads}
        {...overrides}
      />,
    ).replaceAll('<!-- -->', '');
  }

  test('groups by the day, and marks the conversation being read', () => {
    const html = list();

    expect(html).toContain('>Today</h3>');
    expect(html).toContain('>Earlier</h3>');
    expect(html).not.toContain('>Yesterday</h3>');
    expect(html).toContain('aria-current="true"');
    // The model a conversation is pinned to is shown; a default one says
    // nothing rather than repeating what Settings already says.
    expect(html).toContain('gemma4:31b-mlx');
  });

  test('says so when there is nothing to show', () => {
    expect(list({ threads: [] })).toContain('No conversations yet.');
    expect(list({ threads: [], emptyText: 'Nothing here.' })).toContain('Nothing here.');
  });
});

describe('the scheme toggle', () => {
  test('is a radio group with one of the three chosen', () => {
    const html = renderToString(
      <BroappSchemeToggle onChange={() => undefined} value="dark" />,
    ).replaceAll('<!-- -->', '');

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-checked="true" aria-label="Dark"');
    expect(html.split('aria-checked="true"').length - 1).toBe(1);
  });

  test('stacks when it is told to, and says nothing when it is not', () => {
    const vertical = renderToString(
      <BroappSchemeToggle onChange={() => undefined} orientation="vertical" value="light" />,
    );
    const horizontal = renderToString(
      <BroappSchemeToggle onChange={() => undefined} value="light" />,
    );

    expect(vertical).toContain('data-orientation="vertical"');
    expect(horizontal).not.toContain('data-orientation');
  });
});

describe('the conversation menu', () => {
  test('is a closed menu until it is opened', () => {
    const html = renderToString(
      <BroappChatMenu
        onClear={() => undefined}
        onCopy={() => undefined}
        onDelete={() => undefined}
      />,
    ).replaceAll('<!-- -->', '');

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Conversation actions"');
    // Nothing destructive is one click away: the items are inside the menu.
    expect(html).not.toContain('Delete chat');
  });
});

describe('the top bar', () => {
  test('is drawn above the conversation when there is one', () => {
    const html = render({ topBar: <button type="button">Settings</button> });

    expect(html).toContain('broapp-chat__topbar');
    expect(html).toContain('>Settings</button>');
  });

  test('stands in for the empty state while a conversation is read', () => {
    const html = render({ loading: true, suggestions: ['Ask me'] });

    expect(html).toContain('Loading conversation…');
    expect(html).not.toContain('Ask me');
  });
});

describe('18c: a list given earlier', () => {
  const stale = {
    provider: 'ollama',
    message: 'Ollama (local) did not answer. These are the models it listed earlier.',
    reason: 'stale' as const,
    listedAt: new Date(2026, 8, 19, 14, 5).getTime(),
  };

  test('9: its line says when, from one function: a time today, a date another day', () => {
    const sameDay = new Date(2026, 8, 19, 18, 0).getTime();
    expect(unavailableLine(stale, { now: sameDay, locale: 'en-GB' })).toBe(
      'Ollama (local) did not answer. These are the models it listed earlier, at 14:05.',
    );
    const nextWeek = new Date(2026, 8, 26, 9, 0).getTime();
    // The month's abbreviation is the runtime's ICU data's to choose ("Sep" or "Sept").
    expect(unavailableLine(stale, { now: nextWeek, locale: 'en-GB' })).toMatch(
      /^Ollama \(local\) did not answer\. These are the models it listed earlier, on 19 Sept? 2026\.$/,
    );
    // Every other line is the host's own sentence.
    expect(unavailableLine({ message: 'Could not reach Ollama (local).', reason: 'failed' })).toBe('Could not reach Ollama (local).');
    expect(unavailableLine({ message: 'Could not reach Ollama (local).' })).toBe('Could not reach Ollama (local).');
  });

  test('9: the picker names the stale group listed earlier, and draws its line', () => {
    const providers = [
      { id: 'ollama', label: 'Ollama (local)', local: true },
      { id: 'openrouter', label: 'OpenRouter', local: false },
    ];
    expect(groupHeading('ollama', providers, true)).toBe('Ollama (local) — on this computer — listed earlier');
    expect(groupHeading('openrouter', providers)).toBe('OpenRouter — sent to OpenRouter');
    const models: BroappModel[] = [
      { provider: 'ollama', modelId: 'qwen3:27b', label: 'qwen3:27b', capabilities: { tools: true, vision: false, structuredOutput: true } },
    ];
    const html = renderToString(
      <BroappModelList
        models={models}
        value={null}
        defaultLabel="qwen3:27b"
        onChange={() => undefined}
        providers={providers}
        activeProvider="ollama"
        unavailable={[stale]}
      />,
    );
    expect(html).toContain('listed earlier');
    expect(html).toContain('These are the models it listed earlier, ');
    // Still choosable.
    expect(html).toContain('qwen3:27b');
  });

  test('10: a read that is pending keeps the models already shown; only a failure empties the list', () => {
    const models: BroappModel[] = [
      { provider: 'ollama', modelId: 'm', label: 'm', capabilities: { tools: true, vision: false, structuredOutput: true } },
    ];
    const shown = modelsReducer(NO_MODELS, { type: 'read', models, unavailable: [stale] });
    const reading = modelsReducer(shown, { type: 'reading' });
    expect(reading.pending).toBe(true);
    expect(reading.models).toEqual(models);
    expect(reading.unavailable).toEqual([stale]);
    const failed = modelsReducer(reading, { type: 'failed', error: new BroappError('unavailable', 'down') });
    expect(failed).toMatchObject({ models: [], unavailable: [], pending: false });
  });
});
