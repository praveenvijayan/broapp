/**
 * The settings panel.
 *
 * Two things here are deliberate and worth keeping. The key input is
 * write-only — it starts empty, is never filled in from the host, and is
 * cleared after a save — because a key that can be read back out of the
 * interface is a key that can be read by anything that can reach the
 * interface. And the data notice is always visible once a provider is chosen,
 * because "where do my notes go" is not a question a user should have to open
 * a menu to answer.
 *
 * Every control carries two classes: the application's own (`input`, `button`)
 * so a host that styles those still reaches it, and an `ai-settings__` one that
 * `ai.css` dresses, so the panel is whole in a host that styles neither.
 */
import * as React from 'react';

import { useAiModels } from './use-ai-models.ts';
import { useAiSettings, type ConnectionResult } from './use-ai-settings.ts';

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

export function AiSettings(): React.ReactElement {
  const { settings, providers, pending, error, update, test } = useAiSettings();
  const models = useAiModels();
  const [key, setKey] = React.useState('');
  const [replacing, setReplacing] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ConnectionResult | null>(null);

  const provider = providers.find((entry) => entry.id === settings?.provider) ?? null;
  const hasKey = settings?.hasKey === true;
  // The input tracks the saved value until the user types, at which point
  // their draft wins until it is saved on blur.
  const urlValue = baseUrl ?? settings?.baseUrl ?? '';

  const onProvider = async (id: string): Promise<void> => {
    setResult(null);
    setBaseUrl(null);
    setKey('');
    setReplacing(false);
    await update(id === '' ? { provider: undefined } : { provider: id });
  };

  const onSaveKey = async (): Promise<void> => {
    if (key === '') return;
    await update({ apiKey: key });
    setKey('');
    setReplacing(false);
  };

  const onTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    setResult(await test());
    setTesting(false);
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

      <div className="form__row ai-settings__field">
        <label className="form__label ai-settings__label" htmlFor="ai-provider">
          Provider
        </label>
        <Select
          id="ai-provider"
          disabled={pending}
          value={settings?.provider ?? ''}
          onChange={(event) => void onProvider(event.target.value)}
        >
          <option value="">{NOT_SET_UP}</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>
      </div>

      {provider === null ? null : (
        <>
          {provider.needs.baseUrl === 'none' ? null : (
            <div className="form__row ai-settings__field">
              <div className="ai-settings__label-row">
                <label className="form__label ai-settings__label" htmlFor="ai-base-url">
                  Server address
                </label>
                {provider.needs.baseUrl === 'required' ? (
                  <span className="ai-settings__meta" id="ai-base-url-meta">
                    Required
                  </span>
                ) : null}
              </div>
              <input
                className="input ai-settings__input"
                id="ai-base-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                aria-describedby={provider.needs.baseUrl === 'required' ? 'ai-base-url-meta' : undefined}
                placeholder={provider.defaultBaseUrl ?? 'http://127.0.0.1:11434/v1'}
                value={urlValue}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => {
                  if (baseUrl === null) return;
                  const next = baseUrl.trim();
                  setBaseUrl(null);
                  void update({ baseUrl: next === '' ? null : next });
                }}
              />
            </div>
          )}

          {provider.needs.apiKey === 'none' ? null : (
            <>
              <div className="form__row ai-settings__field">
                <div className="ai-settings__label-row">
                  <label className="form__label ai-settings__label" htmlFor="ai-key" id="ai-key-label">
                    API key
                  </label>
                  <span
                    className={`ai-settings__meta${hasKey ? ' ai-settings__meta--ok' : ''}`}
                    id="ai-key-meta"
                  >
                    {hasKey ? 'Saved' : provider.needs.apiKey === 'optional' ? 'Optional' : 'Required'}
                  </span>
                </div>
                {hasKey && !replacing ? (
                  // The saved key is never in the page: only its last characters.
                  <div className="ai-settings__saved-key" role="group" aria-labelledby="ai-key-label ai-key-meta">
                    <KeyIcon />
                    <span className="ai-settings__key-hint">
                      <span aria-hidden="true">•••••••••</span>
                      <span className="ai-settings__sr">A key ending in </span>
                      {settings?.keyHint ?? '…'}
                    </span>
                    <button
                      className="ai-settings__inline-action"
                      type="button"
                      disabled={pending}
                      onClick={() => setReplacing(true)}
                    >
                      Replace
                    </button>
                    <button
                      className="ai-settings__inline-action"
                      type="button"
                      disabled={pending}
                      onClick={() => void update({ apiKey: null })}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="ai-settings__key">
                    <input
                      className="input ai-settings__input"
                      id="ai-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      // Replace was just pressed: the field is why.
                      autoFocus={replacing}
                      disabled={pending}
                      aria-describedby="ai-key-meta"
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
                {provider.needs.apiKey === 'optional' ? (
                  <p className="form__hint ai-settings__hint">
                    Required for hosted services. Optional for local servers.
                  </p>
                ) : null}
              </div>

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
                  Saved in the app&rsquo;s data folder, accessible to your account. Turn off to keep
                  the key only until the app closes.
                </p>
              </div>
            </>
          )}

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
              disabled={pending || models.pending}
              value={settings?.modelId ?? ''}
              onChange={(event) => void update({ modelId: event.target.value })}
            >
              <option value="">{models.pending ? 'Loading…' : 'Choose a model'}</option>
              {models.models.map((model) => (
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
          </div>

          <p className="ai-settings__notice" role="status">
            <InfoIcon />
            <span>
              {provider.local
                ? 'Runs on this computer. Nothing is sent over the internet.'
                : `Messages, open documents and search results are sent to ${provider.label} to generate answers.`}
            </span>
          </p>

          <div className="form__row ai-settings__field">
            <button
              className="button button--primary ai-settings__button ai-settings__button--primary ai-settings__button--block"
              type="button"
              disabled={pending}
              onClick={() => void onTest()}
            >
              {testing ? 'Testing…' : 'Test connection'}
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
        </>
      )}
    </section>
  );
}
