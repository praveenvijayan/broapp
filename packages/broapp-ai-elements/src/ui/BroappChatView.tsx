/**
 * The panel, as a function of what it is showing.
 *
 * Everything that talks to the host lives in `BroappChat.tsx`. This file takes
 * messages, a status and three callbacks and returns markup — which is what
 * lets it be rendered to a string in a test, without a DOM and without a
 * bridge.
 */
import * as React from 'react';

import type { ChatStatus, FileUIPart, ToolUIPart } from 'ai';
import { isDynamicToolUIPart, isToolUIPart } from 'ai';
import { ImageIcon } from 'lucide-react';
import { countdown, isUrgent } from 'broapp/shared';

import { IMAGE_LIMITS } from '../images.ts';
import type { BroappApprovalDescriptor, BroappUIMessage } from '../transport.ts';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './components/ai-elements/conversation.tsx';
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message.tsx';
import {
  ATTACHMENT_UNREADABLE,
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from './components/ai-elements/prompt-input.tsx';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from './components/ai-elements/attachments.tsx';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from './components/ai-elements/tool.tsx';
import { Loader } from './Loader.tsx';

/** Assistant text, rendered as markdown. Links and images are not followed. */
export const Response = MessageResponse;

/** What the view needs to draw itself. */
export interface BroappChatViewProps {
  readonly messages: readonly BroappUIMessage[];
  readonly status: ChatStatus;
  readonly error: string | null;
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  /** For the countdown. The wiring ticks it once a second while one is running. */
  readonly now: number;
  readonly markdown: boolean;
  readonly placeholder: string;
  readonly emptyText: string;
  /** Drawn above the conversation: a model picker, a menu, whatever fits. */
  readonly topBar?: React.ReactNode;
  /** True while a stored conversation is being read. */
  readonly loading?: boolean;
  /** Offered while the transcript is empty; clicking one sends it. */
  readonly suggestions?: readonly string[];
  /** One line under the suggestions, e.g. the keyboard shortcut. */
  readonly suggestionTip?: string;
  /** Characters allowed in one message. Default {@link MESSAGE_MAX_LENGTH}. */
  readonly maxLength?: number;
  /**
   * Phrases the running mark rotates between tool calls, while the model is
   * deciding. Decoration for the wait, not status; the default set is in
   * `Loader.tsx`.
   */
  readonly statusLines?: readonly string[];
  onSend(message: { text: string; files: FileUIPart[] }): void;
  onStop(): void;
  onConfirm(callId: string, approve: boolean): void;
}

/** The name a tool part carries, whichever kind of part it is. */
function toolNameOf(part: ToolUIPart | { type: 'dynamic-tool'; toolName: string }): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);
}

/**
 * The descriptor the transport put on the approval, if it looks right.
 *
 * Checked rather than cast: it arrives as `unknown` from the SDK, and a
 * `expiresAt` that turned out to be a string would render a countdown of
 * `NaN:aN` rather than fail where the mistake is.
 */
function descriptorOf(value: unknown): BroappApprovalDescriptor | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['tool'] !== 'string') return null;
  const expiresAt = record['expiresAt'];
  if (expiresAt !== undefined && typeof expiresAt !== 'number') return null;
  return {
    tool: record['tool'],
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
  };
}

/** Props for {@link ToolApproval}. */
export interface ToolApprovalProps {
  readonly tool: string;
  readonly callId: string;
  readonly expiresAt?: number;
  readonly now: number;
  onConfirm(callId: string, approve: boolean): void;
}

/** The question a person answers before a tool that changes something runs. */
export function ToolApproval({
  tool,
  callId,
  expiresAt,
  now,
  onConfirm,
}: ToolApprovalProps): React.ReactElement {
  const urgent = expiresAt !== undefined && isUrgent(expiresAt, now);
  return (
    <div
      aria-label={`Allow ${tool}?`}
      className={`broapp-chat__confirm${urgent ? ' broapp-chat__confirm--urgent' : ''}`}
      role="group"
    >
      <span>Allow this?</span>
      {expiresAt === undefined ? null : (
        <span className="broapp-chat__expires">expires in {countdown(expiresAt, now)}</span>
      )}
      <button
        className="button button--primary"
        onClick={() => onConfirm(callId, true)}
        type="button"
      >
        Allow
      </button>
      <button className="button" onClick={() => onConfirm(callId, false)} type="button">
        Decline
      </button>
    </div>
  );
}

/** One message's parts, in the order the model produced them. */
/**
 * Whether the running mark shows, and what it says.
 *
 * The mark stands in for whatever has not arrived yet, for the whole turn:
 * before the first word, and between tool cards while the model reads a
 * result and decides. It goes when text is streaming (the words are the sign
 * of life) and when a call waits on the person (the approval card is what
 * they should look at). `activity` names the tool whose result has not come
 * back; `steps` counts the turn's tool calls so far.
 */
function runningOf(
  messages: readonly BroappUIMessage[],
  busy: boolean,
): { activity: string | null; steps: number } | null {
  if (!busy) return null;
  const last = messages.at(-1);
  if (last === undefined || last.role !== 'assistant') return { activity: null, steps: 0 };
  const part = last.parts.at(-1);
  if (part?.type === 'text' && part.state === 'streaming') return null;
  const steps = last.parts.filter((each) => isToolUIPart(each) || isDynamicToolUIPart(each)).length;
  if (part === undefined || (!isToolUIPart(part) && !isDynamicToolUIPart(part))) {
    return { activity: null, steps };
  }
  if (part.state === 'approval-requested') return null;
  const pending = part.state === 'input-streaming' || part.state === 'input-available';
  return { activity: pending ? toolNameOf(part) : null, steps };
}

/**
 * When the current turn began, for the elapsed time and the phrase.
 *
 * Read from the tick the wiring already sends: the first render that sees the
 * turn busy keeps that moment until the turn ends. Not an effect, so the first
 * paint of the mark already knows it — and nothing to run on the server.
 */
function useTurnStart(busy: boolean, now: number): number | null {
  const started = React.useRef<number | null>(null);
  if (!busy) started.current = null;
  else started.current ??= now;
  return started.current;
}

function Parts({
  message,
  markdown,
  now,
  onConfirm,
}: {
  message: BroappUIMessage;
  markdown: boolean;
  now: number;
  onConfirm: (callId: string, approve: boolean) => void;
}): React.ReactElement {
  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}-${String(index)}`;
        if (part.type === 'text') {
          // A person's own words are never markdown: they wrote them, and a
          // stray asterisk should stay an asterisk.
          if (message.role === 'user' || !markdown) {
            return (
              <pre className="broapp-chat__text" key={key}>
                {part.text}
              </pre>
            );
          }
          return <Response key={key}>{part.text}</Response>;
        }
        if (part.type === 'file') {
          // `img-src data:` is in the page's policy, so the image the person
          // just attached renders without a second route being opened.
          return (
            <img
              alt={part.filename ?? 'attachment'}
              className="broapp-chat__image"
              key={key}
              src={part.url}
            />
          );
        }
        if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) return null;
        const tool = toolNameOf(part);
        const descriptor =
          part.state === 'approval-requested' ? descriptorOf(part.approval?.descriptor) : null;
        return (
          <React.Fragment key={key}>
            <Tool>
              <ToolHeader
                state={part.state}
                title={`${part.state === 'output-denied' ? 'Declined' : 'Used'} ${tool}`}
                {...(part.type === 'dynamic-tool'
                  ? { type: 'dynamic-tool' as const, toolName: part.toolName }
                  : { type: part.type })}
              />
              <ToolContent>
                <ToolInput input={part.input} />
                <ToolOutput errorText={part.errorText} output={part.output} />
              </ToolContent>
            </Tool>
            {part.state === 'approval-requested' ? (
              <ToolApproval
                callId={part.toolCallId}
                now={now}
                onConfirm={onConfirm}
                // The descriptor names what is being asked about, which for a
                // step of a call is the step, not the call.
                tool={descriptor?.tool ?? tool}
                {...(descriptor?.expiresAt === undefined ? {} : { expiresAt: descriptor.expiresAt })}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * The button that opens the picker.
 *
 * The vendored `PromptInputActionAddAttachments` is a dropdown-menu item and
 * only works inside a menu; one button for one action needs no menu.
 */
function AddImages(): React.ReactElement {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Add images"
      onClick={() => attachments.openFileDialog()}
      type="button"
    >
      <ImageIcon aria-hidden="true" className="size-4" />
    </PromptInputButton>
  );
}

/**
 * What is attached but not yet sent, with a way to take one back off.
 *
 * A chip appears the moment a file arrives, before it has been read into a
 * `data:` URL; until then it has no thumbnail and the send button is disabled,
 * so the dimmed chip is what says why.
 */
function Pending(): React.ReactElement | null {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader className="broapp-chat__chips">
      <Attachments variant="list">
        {attachments.files.map((file) => (
          <Attachment
            className={file.pending === true ? 'opacity-50' : undefined}
            data={file}
            key={file.id}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

/**
 * What `ai.chat` accepts in one message.
 *
 * The contract caps `message` at 20,000 characters, and a person who has typed
 * that much should learn it from the counter rather than from a refusal after
 * they press Enter.
 */
export const MESSAGE_MAX_LENGTH = 20_000;

/** The sentences an attachment is refused with, by the code the input reports. */
const ATTACHMENT_ERRORS: Record<'max_files' | 'max_file_size' | 'accept', string> = {
  max_files: 'Up to four images per message.',
  max_file_size: 'That image is too large.',
  accept: 'Only PNG, JPEG, GIF and WebP images.',
};

export function BroappChatView({
  messages,
  status,
  error,
  usage,
  now,
  markdown,
  placeholder,
  emptyText,
  topBar,
  loading,
  suggestions,
  suggestionTip,
  maxLength = MESSAGE_MAX_LENGTH,
  statusLines,
  onSend,
  onStop,
  onConfirm,
}: BroappChatViewProps): React.ReactElement {
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  // The textarea is uncontrolled — the form is what reads it on submit — so
  // the count is kept beside it rather than derived from a value in state.
  const [typed, setTyped] = React.useState(0);
  const busy = status === 'submitted' || status === 'streaming';
  const running = runningOf(messages, busy);
  const startedAt = useTurnStart(busy, now);
  // The attachment complaint wins: it is about what the person just did, and a
  // turn's error is about something they have already read.
  const shown = attachmentError ?? error;

  return (
    <div className="broapp-chat">
      {topBar === undefined ? null : <div className="broapp-chat__topbar">{topBar}</div>}
      <Conversation>
        <ConversationContent>
          {loading === true ? (
            // A conversation that is being read has nothing to suggest yet:
            // offering the openers of an empty chat would be a lie about a
            // transcript that is about to appear.
            <ConversationEmptyState description="" title="Loading conversation…" />
          ) : null}
          {loading !== true && messages.length === 0 ? (
            // The caller's sentence is the whole empty state; the component's
            // own second line would say the same thing twice.
            <>
              <ConversationEmptyState description="" title={emptyText} />
              {suggestions === undefined || suggestions.length === 0 ? null : (
                <div className="broapp-chat__suggestions">
                  {suggestions.map((suggestion) => (
                    <button
                      className="broapp-chat__suggestion"
                      key={suggestion}
                      onClick={() => onSend({ text: suggestion, files: [] })}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  ))}
                  {suggestionTip === undefined ? null : (
                    <p className="broapp-chat__tip">{suggestionTip}</p>
                  )}
                </div>
              )}
            </>
          ) : null}
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                <Parts
                  markdown={markdown}
                  message={message}
                  now={now}
                  onConfirm={onConfirm}
                />
              </MessageContent>
            </Message>
          ))}
          {running === null ? null : (
            <Loader
              activity={running.activity}
              elapsedMs={startedAt === null ? null : Math.max(0, now - startedAt)}
              startedAt={startedAt}
              steps={running.steps}
              {...(statusLines === undefined ? {} : { lines: statusLines })}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {shown === null ? null : (
        <p className="message message--error" role="alert">
          {shown}
        </p>
      )}
      {usage === null ? null : (
        <p className="broapp-chat__usage">
          {usage.inputTokens} tokens in, {usage.outputTokens} out
        </p>
      )}

      <PromptInput
        accept={IMAGE_LIMITS.accept}
        className="broapp-chat__form"
        maxFiles={IMAGE_LIMITS.maxFiles}
        // Before downscaling: what the browser shrinks is measured after this.
        maxFileSize={10 * 1024 * 1024}
        multiple
        // A file that could not be read says so itself; every other refusal
        // is one of three generic upstream sentences, replaced here.
        onError={(failure) =>
          setAttachmentError(
            failure.message === ATTACHMENT_UNREADABLE
              ? failure.message
              : ATTACHMENT_ERRORS[failure.code],
          )
        }
        onSubmit={(submitted) => {
          setAttachmentError(null);
          // The form resets itself on submit, so the count has to follow it.
          setTyped(0);
          onSend({ text: submitted.text, files: submitted.files });
        }}
      >
        {/*
          One row: the image button, the box, then the counter and send. The
          chips, when there are any, take a row of their own above it — which
          is what the grid in the stylesheet is for. The vendored input lays
          its children out with flex ordering, and ordering alone cannot put
          three things on one line and a fourth above them.
        */}
        <Pending />
        <PromptInputTools className="broapp-chat__lead">
          <AddImages />
        </PromptInputTools>
        <PromptInputBody>
          <PromptInputTextarea
            maxLength={maxLength}
            onChange={(event) => setTyped(event.currentTarget.value.length)}
            placeholder={placeholder}
          />
        </PromptInputBody>
        <PromptInputTools className="broapp-chat__trail">
          <span
            className={`broapp-chat__counter${typed >= maxLength ? ' broapp-chat__counter--full' : ''}`}
          >
            {typed} / {maxLength}
          </span>
          <PromptInputSubmit onStop={onStop} status={status} />
        </PromptInputTools>
      </PromptInput>
    </div>
  );
}
