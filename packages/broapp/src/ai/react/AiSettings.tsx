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
 */
import * as React from 'react';

import { useAiModels } from './use-ai-models.ts';
import { useAiSettings, type ConnectionResult } from './use-ai-settings.ts';

/** Shown while nothing is chosen. */
const NOT_SET_UP = 'Not set up';

export function AiSettings(): React.ReactElement {
  const { settings, providers, pending, error, update, test } = useAiSettings();
  const models = useAiModels();
  const [key, setKey] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ConnectionResult | null>(null);

  const provider = providers.find((entry) => entry.id === settings?.provider) ?? null;
  // The input tracks the saved value until the user types, at which point
  // their draft wins until it is saved on blur.
  const urlValue = baseUrl ?? settings?.baseUrl ?? '';

  const onProvider = async (id: string): Promise<void> => {
    setResult(null);
    setBaseUrl(null);
    setKey('');
    await update(id === '' ? { provider: undefined } : { provider: id });
  };

  const onSaveKey = async (): Promise<void> => {
    if (key === '') return;
    await update({ apiKey: key });
    setKey('');
  };

  return (
    <section className="card ai-settings" aria-labelledby="ai-settings-title">
      <h2 className="card__title" id="ai-settings-title">
        AI
      </h2>

      {error !== null ? (
        <p className="message message--error" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="form__row">
        <label className="form__label" htmlFor="ai-provider">
          Provider
        </label>
        <select
          className="input input--select"
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
        </select>
      </div>

      {provider === null ? null : (
        <>
          {provider.needs.baseUrl === 'none' ? null : (
            <div className="form__row">
              <label className="form__label" htmlFor="ai-base-url">
                Server address{provider.needs.baseUrl === 'required' ? ' (required)' : ''}
              </label>
              <input
                className="input"
                id="ai-base-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
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

          {!provider.needs.apiKey ? null : (
            <div className="form__row">
              <label className="form__label" htmlFor="ai-key">
                API key
              </label>
              <div className="ai-settings__key">
                <input
                  className="input"
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  placeholder={settings?.hasKey === true ? 'Replace the saved key' : 'Paste the key'}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  onBlur={() => void onSaveKey()}
                />
                <button
                  className="button button--primary"
                  type="button"
                  disabled={pending || key === ''}
                  onClick={() => void onSaveKey()}
                >
                  Save key
                </button>
              </div>
              {settings?.hasKey === true ? (
                <p className="form__hint">
                  A key ending in {settings.keyHint ?? '…'} is saved.{' '}
                  <button
                    className="button"
                    type="button"
                    disabled={pending}
                    onClick={() => void update({ apiKey: null })}
                  >
                    Remove key
                  </button>
                </p>
              ) : null}
              <label className="form__label ai-settings__remember" htmlFor="ai-remember">
                <input
                  id="ai-remember"
                  type="checkbox"
                  disabled={pending}
                  checked={settings?.remember ?? true}
                  onChange={(event) => void update({ remember: event.target.checked })}
                />
                Remember key on this computer
              </label>
              <p className="form__hint">
                Stored in this application&rsquo;s data folder, readable by your user account. Turn
                off to keep it only until the app closes.
              </p>
            </div>
          )}

          <div className="form__row">
            <label className="form__label" htmlFor="ai-model">
              Model
            </label>
            <div className="ai-settings__key">
              <select
                className="input input--select"
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
              </select>
              <button
                className="button"
                type="button"
                disabled={models.pending}
                onClick={() => void models.refresh()}
              >
                Refresh
              </button>
            </div>
            {models.error === null ? null : (
              <p className="message message--error" role="alert">
                {models.error.message}
              </p>
            )}
          </div>

          <p className="ai-settings__notice" role="status">
            {provider.local
              ? 'Runs on this computer. Nothing is sent over the internet.'
              : `Messages, the documents you are viewing, and search results are sent to ${provider.label} to generate answers.`}
          </p>

          <div className="form__row">
            <button
              className="button button--primary"
              type="button"
              disabled={pending}
              onClick={() => void test().then(setResult)}
            >
              Test connection
            </button>
            {result === null ? null : (
              <p className={`message ${result.ok ? 'message--ok' : 'message--error'}`} role="status">
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
