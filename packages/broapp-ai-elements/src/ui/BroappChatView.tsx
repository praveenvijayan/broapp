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
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
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
                tool={tool}
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

/** What is attached but not yet sent, with a way to take one back off. */
function Pending(): React.ReactElement | null {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader>
      <Attachments variant="list">
        {attachments.files.map((file) => (
          <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

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
  onSend,
  onStop,
  onConfirm,
}: BroappChatViewProps): React.ReactElement {
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const busy = status === 'submitted' || status === 'streaming';
  // The loader stands in for the reply until the first word of it arrives.
  const writing = messages.at(-1)?.parts.some((part) => part.type === 'text') === true;
  // The attachment complaint wins: it is about what the person just did, and a
  // turn's error is about something they have already read.
  const shown = attachmentError ?? error;

  return (
    <div className="broapp-chat">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            // The caller's sentence is the whole empty state; the component's
            // own second line would say the same thing twice.
            <ConversationEmptyState description="" title={emptyText} />
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
          {busy && !writing ? <Loader /> : null}
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
        maxFiles={IMAGE_LIMITS.maxFiles}
        // Before downscaling: what the browser shrinks is measured after this.
        maxFileSize={10 * 1024 * 1024}
        multiple
        onError={(failure) => setAttachmentError(ATTACHMENT_ERRORS[failure.code])}
        onSubmit={(submitted) => {
          setAttachmentError(null);
          onSend({ text: submitted.text, files: submitted.files });
        }}
      >
        <Pending />
        <PromptInputBody>
          <PromptInputTextarea placeholder={placeholder} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <AddImages />
          </PromptInputTools>
          <PromptInputSubmit onStop={onStop} status={status} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
