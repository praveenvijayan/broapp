/**
 * The settings panel.
 *
 * One panel, in two parts. **In use** is the provider a conversation and a
 * task run on when nothing says otherwise, its model, and where it sends
 * things. **Providers** is every provider in the build, each with its own
 * address, key, test and switch, because a model reference may name any
 * provider that is turned on, and each keeps its own settings.
 *
 * Two things here are deliberate and worth keeping. A key input is
 * write-only — it starts empty, is never filled in from the host, and is
 * cleared after a save — because a key that can be read back out of the
 * interface is a key that can be read by anything that can reach the
 * interface. And where things are sent is always visible once a provider is
 * chosen, because "where do my notes go" is not a question a user should have
 * to open a menu to answer.
 *
 * Every control carries two classes: the application's own (`input`, `button`)
 * so a host that styles those still reaches it, and an `ai-settings__` one that
 * `ai.css` dresses, so the panel is whole in a host that styles neither.
 */
import * as React from 'react';

import { unavailableLine, unavailableReason } from '../shared/model-ref.ts';
import type { ProviderInfo, ProviderSettings } from '../shared/types.ts';

import { useAiModels } from './use-ai-models.ts';
import { useAiSettings, type ConnectionResult, type UpdatePatch } from './use-ai-settings.ts';

/** Shown while nothing is chosen. */
const NOT_SET_UP = 'Not set up';

/*
 * The icons are drawn here rather than imported: this package has no icon
 * dependency, and a Broapp page may load nothing from off-origin.
 */
function Icon({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ai-settings__icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

const ChevronIcon = (): React.ReactElement => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const KeyIcon = (): React.ReactElement => (
  <Icon>
    <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
    <path d="m21 2-9.6 9.6" />
    <circle cx="7.5" cy="15.5" r="5.5" />
  </Icon>
);

const RefreshIcon = (): React.ReactElement => (
  <Icon>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Icon>
);

const InfoIcon = (): React.ReactElement => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Icon>
);

/** A select with the panel's own chevron: `ai.css` may not use `url()`. */
function Select(props: React.ComponentProps<'select'>): React.ReactElement {
  return (
    <span className="ai-settings__select">
      <select {...props} className="input input--select ai-settings__input" />
      <ChevronIcon />
    </span>
  );
}

/** The host of an address, for a summary line; the address itself when it does not parse. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** A provider's summary line: where it runs, then on, off, or what it is missing. */
export function providerSummary(info: ProviderInfo, entry: ProviderSettings | undefined, inUse: boolean): string {
  const address = entry?.baseUrl ?? info.defaultBaseUrl;
  const where = info.local
    ? 'on this computer'
    : address === null || address === ''
      ? 'no address yet'
      : `sent to ${hostOf(address)}`;
  let state: string;
  if (entry?.configured === false) {
    state =
      info.needs.apiKey === 'required' && entry.hasKey !== true
        ? 'needs a key'
        : info.needs.baseUrl === 'required'
          ? 'needs an address'
          : 'not ready';
  } else {
    state = inUse ? 'in use' : entry?.enabled === true ? 'on' : 'off';
  }
  return `${info.label} — ${where} · ${state}`;
}

/**
 * The sentence under "In use" about the other providers: what is sent to
 * them, or, when every provider that is on runs here, that nothing leaves.
 */
export function othersSentence(
  providers: readonly ProviderInfo[],
  settings: { readonly provider: string | null; readonly providers: readonly ProviderSettings[] },
): string | null {
  const enabled = providers.filter(
    (info) => info.id !== settings.provider && settings.providers.some((entry) => entry.id === info.id && entry.enabled),
  );
  if (enabled.length === 0) return null;
  const remote = enabled.filter((info) => !info.local);
  if (remote.length > 0) {
    const labels = remote.map((info) => info.label);
    const named = labels.length === 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
    return `Tasks and conversations that choose a model from ${named} are sent there instead.`;
  }
  const inUse = providers.find((info) => info.id === settings.provider);
  return inUse?.local === true
    ? 'Every provider turned on runs on this computer. Nothing is sent over the internet.'
    : null;
}

interface ProviderDetailsProps {
  readonly info: ProviderInfo;
  readonly entry: ProviderSettings | undefined;
  readonly inUse: boolean;
  readonly pending: boolean;
  readonly defaultOpen: boolean;
  update(patch: UpdatePatch): Promise<void>;
  test(provider: string): Promise<ConnectionResult | null>;
}

/** One provider's own settings: address, key, test and whether its models are offered. */
function ProviderDetails({ info, entry, inUse, pending, defaultOpen, update, test }: ProviderDetailsProps): React.ReactElement {
  const [key, setKey] = React.useState('');
  const [replacing, setReplacing] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ConnectionResult | null>(null);
  const hasKey = entry?.hasKey === true;
  const id = info.id;
  // Every control writes to this provider by name, never to "the one in use".
  const write = (patch: Omit<UpdatePatch, 'target'>): Promise<void> => update({ ...patch, target: id });
  const urlValue = baseUrl ?? entry?.baseUrl ?? '';
  const field = (name: string): string => `ai-${name}-${id}`;

  const onSaveKey = async (): Promise<void> => {
    if (key === '') return;
    await write({ apiKey: key });
    setKey('');
    setReplacing(false);
  };

  const onTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    setResult(await test(id));
    setTesting(false);
  };

  return (
    <details className="ai-settings__provider" open={defaultOpen || undefined}>
      <summary className="ai-settings__provider-summary">{providerSummary(info, entry, inUse)}</summary>
      <div className="ai-settings__provider-body">
        {info.needs.baseUrl === 'none' ? null : (
          <div className="form__row ai-settings__field">
            <div className="ai-settings__label-row">
              <label className="form__label ai-settings__label" htmlFor={field('base-url')}>
                Server address
              </label>
              {info.needs.baseUrl === 'required' ? (
                <span className="ai-settings__meta" id={field('base-url-meta')}>
                  Required
                </span>
              ) : null}
            </div>
            <input
              className="input ai-settings__input"
              id={field('base-url')}
              type="url"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-describedby={info.needs.baseUrl === 'required' ? field('base-url-meta') : undefined}
              placeholder={info.defaultBaseUrl ?? 'http://127.0.0.1:11434/v1'}
              value={urlValue}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={() => {
                if (baseUrl === null) return;
                const next = baseUrl.trim();
                setBaseUrl(null);
                void write({ baseUrl: next === '' ? null : next });
              }}
            />
          </div>
        )}

        {info.needs.apiKey === 'none' ? null : (
          <div className="form__row ai-settings__field">
            <div className="ai-settings__label-row">
              <label className="form__label ai-settings__label" htmlFor={field('key')} id={field('key-label')}>
                API key
              </label>
              <span className={`ai-settings__meta${hasKey ? ' ai-settings__meta--ok' : ''}`} id={field('key-meta')}>
                {hasKey ? 'Saved' : info.needs.apiKey === 'optional' ? 'Optional' : 'Required'}
              </span>
            </div>
            {hasKey && !replacing ? (
              // The saved key is never in the page: only its last characters.
              <div className="ai-settings__saved-key" role="group" aria-labelledby={`${field('key-label')} ${field('key-meta')}`}>
                <KeyIcon />
                <span className="ai-settings__key-hint">
                  <span aria-hidden="true">•••••••••</span>
                  <span className="ai-settings__sr">A key ending in </span>
                  {entry?.keyHint ?? '…'}
                </span>
                <button className="ai-settings__inline-action" type="button" disabled={pending} onClick={() => setReplacing(true)}>
                  Replace
                </button>
                <button className="ai-settings__inline-action" type="button" disabled={pending} onClick={() => void write({ apiKey: null })}>
                  Remove
                </button>
              </div>
            ) : (
              <div className="ai-settings__key">
                <input
                  className="input ai-settings__input"
                  id={field('key')}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  // Replace was just pressed: the field is why.
                  autoFocus={replacing}
                  disabled={pending}
                  aria-describedby={field('key-meta')}
                  placeholder={hasKey ? 'Paste the new key' : 'Paste the key'}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  onBlur={() => void onSaveKey()}
                />
                <button
                  className="button button--primary ai-settings__button ai-settings__button--primary"
                  type="button"
                  disabled={pending || key === ''}
                  onClick={() => void onSaveKey()}
                >
                  Save
                </button>
                {replacing ? (
                  <button
                    className="button ai-settings__button"
                    type="button"
                    // Keeps the field's blur — which saves — from running first.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setKey('');
                      setReplacing(false);
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            )}
            {info.needs.apiKey === 'optional' ? (
              <p className="form__hint ai-settings__hint">Required for hosted services. Optional for local servers.</p>
            ) : null}
          </div>
        )}

        <div className="form__row ai-settings__field">
          <label className="ai-settings__switch-row" htmlFor={field('offer')}>
            <span className="ai-settings__label">Offer this provider&rsquo;s models</span>
            <input
              className="ai-settings__switch"
              id={field('offer')}
              type="checkbox"
              role="switch"
              disabled={pending || inUse}
              aria-describedby={inUse ? field('offer-hint') : undefined}
              checked={inUse || entry?.enabled === true}
              onChange={(event) => void write({ enabled: event.target.checked })}
            />
          </label>
          {inUse ? (
            <p className="form__hint ai-settings__hint" id={field('offer-hint')}>
              In use
            </p>
          ) : null}
        </div>

        <div className="form__row ai-settings__field">
          <button className="button ai-settings__button" type="button" disabled={pending} onClick={() => void onTest()}>
            {testing ? 'Testing…' : 'Test'}
          </button>
          {result === null ? null : (
            <p
              className={`message ${result.ok ? 'message--ok' : 'message--error'} ai-settings__message ai-settings__message--${result.ok ? 'ok' : 'error'}`}
              role="status"
            >
              {result.message}
              {result.ok ? ` (${String(result.latencyMs)} ms)` : ''}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

export function AiSettings(): React.ReactElement {
  const { settings, providers, pending, error, update, test } = useAiSettings();
  const models = useAiModels();
  const [inUseResult, setInUseResult] = React.useState<ConnectionResult | null>(null);

  const active = settings?.provider ?? null;
  const provider = providers.find((entry) => entry.id === active) ?? null;
  // The model select offers the provider in use only: the Settings model is a
  // bare id, and lives inside its provider's entry.
  const own = models.models.filter((model) => model.provider === active);
  const ownUnavailable = models.unavailable.filter((entry) => entry.provider === active);
  const others = settings === null ? null : othersSentence(providers, settings);

  const onProvider = async (id: string): Promise<void> => {
    await update(id === '' ? { provider: undefined } : { provider: id, target: id });
  };

  return (
    <section className="card ai-settings" aria-labelledby="ai-settings-title">
      <header className="ai-settings__header">
        <h2 className="card__title ai-settings__title" id="ai-settings-title">
          AI connection
        </h2>
        <p className="ai-settings__lede">Choose how your assistant connects.</p>
      </header>

      {error !== null ? (
        <p className="message message--error ai-settings__message ai-settings__message--error" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="ai-settings__section" role="group" aria-labelledby="ai-in-use-title">
        <h3 className="ai-settings__section-title" id="ai-in-use-title">
          In use
        </h3>
        <div className="form__row ai-settings__field">
          <label className="form__label ai-settings__label" htmlFor="ai-provider">
            Provider
          </label>
          <Select
            id="ai-provider"
            disabled={pending}
            aria-describedby="ai-provider-hint"
            value={active ?? ''}
            onChange={(event) => void onProvider(event.target.value)}
          >
            <option value="">{NOT_SET_UP}</option>
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
          <p className="form__hint ai-settings__hint" id="ai-provider-hint">
            What a conversation and a task run on when nothing says otherwise.
          </p>
        </div>

        {provider === null ? null : (
          <>
            <div className="form__row ai-settings__field">
              <div className="ai-settings__label-row">
                <label className="form__label ai-settings__label" htmlFor="ai-model">
                  Model
                </label>
                <button
                  className="ai-settings__inline-action ai-settings__inline-action--icon"
                  type="button"
                  disabled={models.pending}
                  onClick={() => void models.refresh()}
                >
                  <RefreshIcon />
                  Refresh
                </button>
              </div>
              <Select
                id="ai-model"
                // A list already shown stays choosable while a new one is read:
                // "Loading" is for a select that has nothing in it yet.
                disabled={pending || (models.pending && own.length === 0)}
                value={settings?.modelId ?? ''}
                onChange={(event) => void update({ modelId: event.target.value, target: provider.id })}
              >
                <option value="">{models.pending && own.length === 0 ? 'Loading…' : 'Choose a model'}</option>
                {own.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.label}
                  </option>
                ))}
              </Select>
              {models.error === null ? null : (
                <p className="message message--error ai-settings__message ai-settings__message--error" role="alert">
                  {models.error.message}
                </p>
              )}
              {ownUnavailable.map((entry) =>
                // A list given earlier is still a list: said, quietly, not raised as an error.
                unavailableReason(entry) === 'stale' ? (
                  <p className="form__hint ai-settings__hint" key={entry.message} role="status">
                    {unavailableLine(entry)}
                  </p>
                ) : (
                  <p className="message message--error ai-settings__message ai-settings__message--error" key={entry.message} role="alert">
                    {unavailableLine(entry)}
                  </p>
                ),
              )}
            </div>

            <p className="ai-settings__notice" role="status">
              <InfoIcon />
              <span>
                {provider.local
                  ? 'Runs on this computer. Nothing is sent over the internet.'
                  : `Messages, open documents and search results are sent to ${provider.label} to generate answers.`}
                {others === null ? null : (
                  <>
                    {' '}
                    {others}
                  </>
                )}
              </span>
            </p>

            <div className="form__row ai-settings__field">
              <button
                className="button button--primary ai-settings__button ai-settings__button--primary ai-settings__button--block"
                type="button"
                disabled={pending}
                onClick={() => void (async () => setInUseResult(await test()))()}
              >
                Test connection
              </button>
              {inUseResult === null ? null : (
                <p
                  className={`message ${inUseResult.ok ? 'message--ok' : 'message--error'} ai-settings__message ai-settings__message--${inUseResult.ok ? 'ok' : 'error'}`}
                  role="status"
                >
                  {inUseResult.message}
                  {inUseResult.ok ? ` (${String(inUseResult.latencyMs)} ms)` : ''}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {providers.length === 0 ? null : (
        <div className="ai-settings__section" role="group" aria-labelledby="ai-providers-title">
          <h3 className="ai-settings__section-title" id="ai-providers-title">
            Providers
          </h3>
          <p className="form__hint ai-settings__hint">
            A provider that is on offers its models to every conversation and task, and is sent what they send it.
            One that is off is never contacted except by its own Test.
          </p>
          <div className="ai-settings__providers">
            {providers.map((info) => (
              <ProviderDetails
                defaultOpen={info.id === active}
                entry={settings?.providers.find((entry) => entry.id === info.id)}
                info={info}
                inUse={info.id === active}
                key={info.id}
                pending={pending}
                test={test}
                update={update}
              />
            ))}
          </div>
        </div>
      )}

      <div className="form__row ai-settings__field">
        <label className="ai-settings__switch-row" htmlFor="ai-remember">
          <span className="ai-settings__label">Remember key on this computer</span>
          <input
            className="ai-settings__switch"
            id="ai-remember"
            type="checkbox"
            role="switch"
            disabled={pending}
            aria-describedby="ai-remember-hint"
            checked={settings?.remember ?? true}
            onChange={(event) => void update({ remember: event.target.checked })}
          />
        </label>
        <p className="form__hint ai-settings__hint" id="ai-remember-hint">
          Applies to every provider&rsquo;s key. Saved in the app&rsquo;s data folder, accessible to your account. Turn
          off to keep keys only until the app closes.
        </p>
      </div>
    </section>
  );
}
