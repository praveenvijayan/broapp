# broapp-ai-anthropic

The Anthropic adapter for a [Broapp](https://github.com/praveenvijayan/broapp)
application's AI layer. Wraps `@ai-sdk/anthropic` behind Broapp's
`ProviderAdapter` interface.

```bash
bun add broapp-ai-anthropic
```

```ts
import { createAi } from 'broapp/ai/host';
import { anthropic } from 'broapp-ai-anthropic';

const ai = createAi({ dataDir, providers: [anthropic()], app: { name, purpose } });
```

The user supplies the API key in the application's settings panel; it is
stored by the host, never by the browser. Listing models is how the adapter
tests a key, so the test costs no tokens. Errors reach the user as plain
sentences with the provider's response body attached only on the host.

This adapter always counts as remote: the settings panel tells the user what
is sent to Anthropic. Full documentation:
[docs/ai.md](https://github.com/praveenvijayan/broapp/blob/main/docs/ai.md).

MIT.
