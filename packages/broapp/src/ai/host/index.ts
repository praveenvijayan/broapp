/**
 * `broapp/ai/host` — the AI layer's host runtime.
 *
 * This is the only entry point that reaches the AI SDK. Never import it from
 * browser code: the page's CSP allows `connect-src 'self'` and loopback only,
 * so a browser that could reach a provider would be a bug, and a bundler that
 * follows this import fails loudly instead.
 */
export { createAi } from './create-ai.ts';
export type { Ai, AiAppDescription, CreateAiOptions } from './create-ai.ts';

export { AdapterError, isLoopbackUrl, toPublicError } from './adapter.ts';
export type { AdapterConfig, AdapterErrorCode, ProviderAdapter } from './adapter.ts';

export { createFakeAdapter } from './fake.ts';
export type { FakeAdapterOptions } from './fake.ts';

export { apiKeySecretName, createFileSecretStore, createMemorySecretStore } from './secrets.ts';
export type { SecretStore } from './secrets.ts';

export type { Registry, ResolvedModel, UpdatePatch } from './registry.ts';
