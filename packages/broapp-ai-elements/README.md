# broapp-ai-elements

The AI SDK transport and AI Elements chat panel for a Broapp application. It
turns Broapp's `ai.chat` stream into what the AI SDK's `useChat` expects, so a
panel gets markdown, attachments and tool cards from standard packages instead
of hand-rolled code.

```ts
import { useBroappChat } from 'broapp-ai-elements';
```

```tsx
import { BroappChat } from 'broapp-ai-elements/ui';
import 'broapp-ai-elements/styles.css';
```

The host does not change: see `docs/ai.md` for the AI layer itself, its
settings routes and the confirmation gate.
