# broapp-ai-compatible

The OpenAI-compatible adapter for a
[Broapp](https://github.com/praveenvijayan/broapp) application's AI layer.
Wraps `@ai-sdk/openai-compatible` behind Broapp's `ProviderAdapter`
interface, so one package covers OpenAI, Ollama, LM Studio, llama.cpp, vLLM,
OpenRouter and any other server that speaks the OpenAI chat API.

```bash
bun add broapp-ai-compatible
```

```ts
import { createAi } from 'broapp/ai/host';
import { ollama, openai, customServer, openaiCompatible } from 'broapp-ai-compatible';

const ai = createAi({
  dataDir,
  providers: [ollama(), openai(), customServer()],
  app: { name, purpose },
});
```

| Export | Provider id | Default server URL | Needs |
| --- | --- | --- | --- |
| `ollama()` | `ollama` | `http://127.0.0.1:11434/v1` | nothing |
| `openai()` | `openai` | `https://api.openai.com/v1` | API key |
| `customServer()` | `openai-compatible` | none | server URL; API key optional (OpenRouter wants one, a local server usually not) |
| `openaiCompatible({...})` | yours | yours | yours |

Whether a provider counts as local is decided from the server URL at the time
the user looks: a loopback host means nothing leaves the machine, anything
else and the settings panel says what is sent. Full documentation:
[docs/ai.md](https://github.com/praveenvijayan/broapp/blob/main/docs/ai.md).

MIT.
