/**
 * `broapp-ai-elements/ui` — the chat panel and the parts it is made of.
 *
 * `BroappChat` is the whole panel. The primitives below it are re-exported so
 * an application that wants a different arrangement can compose one without
 * vendoring the registry a second time. Pair either with
 * `broapp-ai-elements/styles.css`.
 */
export { BroappChat } from './BroappChat.tsx';
export type { BroappChatProps } from './BroappChat.tsx';

export { BroappChatView, Response, ToolApproval } from './BroappChatView.tsx';
export type { BroappChatViewProps, ToolApprovalProps } from './BroappChatView.tsx';

export { Loader } from './Loader.tsx';

export {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './components/ai-elements/conversation.tsx';
export {
  Message,
  MessageContent,
  MessageResponse,
} from './components/ai-elements/message.tsx';
export {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from './components/ai-elements/prompt-input.tsx';
export {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from './components/ai-elements/attachments.tsx';
export {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from './components/ai-elements/tool.tsx';
