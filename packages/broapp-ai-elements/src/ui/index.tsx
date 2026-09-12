/**
 * `broapp-ai-elements/ui` — the chat panel and the parts it is made of.
 *
 * `BroappChat` is the whole panel. The primitives below it are re-exported so
 * an application that wants a different arrangement can compose one without
 * vendoring the registry a second time. Pair either with
 * `broapp-ai-elements/styles.css`.
 */
export { BroappChat } from './BroappChat.tsx';
export type { BroappChatControls, BroappChatProps } from './BroappChat.tsx';

export { BroappChatDrawer, BroappChatToggle } from './BroappChatDrawer.tsx';
export type {
  BroappChatDrawerProps,
  BroappChatToggleProps,
} from './BroappChatDrawer.tsx';

export { BroappChatMenu } from './BroappChatMenu.tsx';
export type { BroappChatMenuProps } from './BroappChatMenu.tsx';

export { BroappModelList, BroappModelPicker } from './BroappModelPicker.tsx';
export type { BroappModelListProps, BroappModelPickerProps } from './BroappModelPicker.tsx';

export { BroappSchemeToggle } from './BroappSchemeToggle.tsx';
export type { BroappScheme, BroappSchemeToggleProps } from './BroappSchemeToggle.tsx';

export { BroappThreadList } from './BroappThreadList.tsx';
export type { BroappThreadListProps } from './BroappThreadList.tsx';

export { transcriptOf } from './transcript.ts';

export { BroappChatView, MESSAGE_MAX_LENGTH, Response, ToolApproval } from './BroappChatView.tsx';
export type { BroappChatViewProps, ToolApprovalProps } from './BroappChatView.tsx';

export { DEFAULT_STATUS_LINES, Loader, STATUS_LINE_MS, formatElapsed, statusLine } from './Loader.tsx';
export type { LoaderProps } from './Loader.tsx';

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
  ATTACHMENT_UNREADABLE,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from './components/ai-elements/prompt-input.tsx';
export type {
  PromptInputAttachment,
  PromptInputAttachmentError,
} from './components/ai-elements/prompt-input.tsx';
export { settleForSubmit } from './components/ai-elements/pending-files.ts';
export type { PendingEntry } from './components/ai-elements/pending-files.ts';
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

/*
 * The vendored select, exported because it is the panel's portalled component:
 * an application composing its own bar needs it, and `bun run theme-check`
 * drives it to prove that what a portal draws outside the panel still carries
 * the panel's colours.
 */
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.tsx';
