/**
 * Which model this conversation talks to.
 *
 * The first row is "Default (follow Settings)", because a conversation that
 * follows Settings is the normal case and pinning one to a model is the
 * exception. Below it, every model of every provider turned on in Settings,
 * grouped by provider, each group saying where its models run: choosing a
 * model can decide which key is used and whether anything leaves the
 * computer, so that is said wherever a model is chosen, in words. A choice is
 * written as a model reference that names its provider, never a bare id.
 */
import * as React from 'react';

import { Check, ChevronDown, Eye } from 'lucide-react';
import { Popover } from 'radix-ui';

import { describeModel, findModel, formatModelRef, whereItRuns } from 'broapp/ai';
import type { BroappModel, ProviderPlace, UnavailableProvider } from 'broapp/ai';
import { useAiContext, useAiModels, useAiSettings } from 'broapp/ai/react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './components/ui/command.tsx';

/** The sentence shown on a disabled picker, and why it is disabled. */
const NOT_CONFIGURED = 'Choose a provider in Settings';

/** Props for {@link BroappModelPicker}. */
export interface BroappModelPickerProps {
  /** The model reference this conversation is pinned to. Null follows Settings. */
  readonly value: string | null;
  /** Called with a qualified reference, or null to follow Settings. */
  onChange(modelId: string | null): void;
  readonly disabled?: boolean;
  /**
   * How many messages the conversation has sent. When it grows, the line that
   * says a choice moved the conversation on or off this computer goes away:
   * it is there until the next message, so the choice is not silent.
   */
  readonly sent?: number;
}

/** Props for {@link BroappModelList}. */
export interface BroappModelListProps {
  readonly models: readonly BroappModel[];
  readonly value: string | null;
  /** What the "Default" row says Settings currently points at. */
  readonly defaultLabel: string;
  /** Where the Settings model runs, in the words of `whereItRuns`. */
  readonly defaultWhere?: string | null;
  onChange(modelId: string | null): void;
  readonly loading?: boolean;
  readonly error?: string | null;
  /** The providers in the build's order, with where each runs. */
  readonly providers?: readonly ProviderPlace[];
  /** The provider a bare stored reference names. */
  readonly activeProvider?: string | null;
  /** Providers whose models could not be read, one line each under the list. */
  readonly unavailable?: readonly UnavailableProvider[];
}

/**
 * A provider's mark: the first letter of its name in a rounded square.
 *
 * A letter rather than a logo, because a logo is a file from somewhere else
 * and a Broapp page loads nothing off-origin.
 */
function Mark({ provider }: { provider: string }): React.ReactElement {
  return (
    <span aria-hidden="true" className="broapp-chat-option__mark">
      {(provider[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** A group's heading: the provider's label, and where its models run. */
function groupHeading(provider: string, providers: readonly ProviderPlace[]): string {
  const place = providers.find((entry) => entry.id === provider);
  return place === undefined ? provider : `${place.label} — ${whereItRuns(place)}`;
}

/**
 * The rows inside the picker, as a function of what there is to choose from.
 *
 * Split out from the picker so it can be rendered without a connection: the
 * picker itself reads `useAiModels`, which answers nothing until an effect has
 * run.
 */
export function BroappModelList({
  models,
  value,
  defaultLabel,
  defaultWhere = null,
  onChange,
  loading,
  error,
  providers = [],
  activeProvider = null,
  unavailable = [],
}: BroappModelListProps): React.ReactElement {
  const current = value === null ? null : findModel(value, models, activeProvider, providers.map((entry) => entry.id)).model;
  // In the build's order, then any provider the list names that the order does not.
  const order = [...providers.map((entry) => entry.id)];
  for (const model of models) if (!order.includes(model.provider)) order.push(model.provider);
  const groups = order
    .map((provider) => ({ provider, models: models.filter((model) => model.provider === provider) }))
    .filter((group) => group.models.length > 0);
  return (
    <Command className="broapp-chat-picker__command">
      <CommandInput placeholder="Search models" />
      <CommandList>
        {error === undefined || error === null ? null : (
          <p className="broapp-chat-picker__error" role="alert">
            {error}
          </p>
        )}
        <CommandEmpty>
          {loading === true ? 'Reading the models…' : 'No models.'}
        </CommandEmpty>
        <CommandGroup>
          <CommandItem
            className="broapp-chat-option"
            onSelect={() => onChange(null)}
            value="__default__ Default follow Settings"
          >
            <span className="broapp-chat-option__label">Default (follow Settings)</span>
            <span className="broapp-chat-option__muted">
              {defaultWhere === null ? defaultLabel : `${defaultLabel} · ${defaultWhere}`}
            </span>
            {value === null ? <Check aria-label="Current" size={15} /> : null}
          </CommandItem>
        </CommandGroup>
        {groups.map((group) => {
          const heading = groupHeading(group.provider, providers);
          return (
            <CommandGroup heading={heading} key={group.provider}>
              {group.models.map((model) => (
                <CommandItem
                  className="broapp-chat-option"
                  key={`${model.provider}/${model.modelId}`}
                  onSelect={() => onChange(formatModelRef(model.provider, model.modelId))}
                  value={`${model.modelId} ${model.label} ${model.provider} ${heading}`}
                >
                  <Mark provider={model.provider} />
                  <span className="broapp-chat-option__label">{model.label}</span>
                  {model.capabilities.vision ? (
                    <span className="broapp-chat-option__badge">
                      <Eye aria-hidden="true" size={12} />
                      vision
                    </span>
                  ) : null}
                  {current === model ? <Check aria-label="Current" size={15} /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
        {unavailable.map((entry) => (
          <p className="broapp-chat-picker__unavailable broapp-chat-option__muted" key={`${entry.provider} ${entry.message}`}>
            {entry.message}
          </p>
        ))}
      </CommandList>
    </Command>
  );
}

/**
 * Whether a reference — or, for `null`, the Settings model — runs on this
 * computer, or `null` when that is not known.
 */
function isLocal(
  value: string | null,
  context: { models: readonly BroappModel[]; providers: readonly ProviderPlace[]; activeProvider: string | null },
): boolean | null {
  const provider =
    value === null
      ? context.activeProvider
      : findModel(value, context.models, context.activeProvider, context.providers.map((entry) => entry.id)).provider;
  return context.providers.find((entry) => entry.id === provider)?.local ?? null;
}

/** The line a choice earns when it moves a conversation on or off this computer. */
export function moveLine(before: boolean | null, after: boolean | null, label: string | null): string | null {
  if (before === null || after === null || before === after) return null;
  return after
    ? 'From the next message, this conversation stays on this computer.'
    : `From the next message, this conversation is sent to ${label ?? 'another provider'}.`;
}

export function BroappModelPicker({
  value,
  onChange,
  disabled,
  sent,
}: BroappModelPickerProps): React.ReactElement {
  const { settings } = useAiContext();
  const { providers: listed } = useAiSettings();
  const { models, unavailable, pending, error } = useAiModels();
  const [open, setOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  // The line lasts until the next message is sent.
  const seen = React.useRef(sent);
  React.useEffect(() => {
    if (sent !== seen.current) setNotice(null);
    seen.current = sent;
  }, [sent]);

  const providers: ProviderPlace[] = listed.map((entry) => ({ id: entry.id, label: entry.label, local: entry.local }));
  const activeProvider = settings?.provider ?? null;
  const enabled = (settings?.providers ?? []).filter((entry) => entry.enabled).map((entry) => entry.id);
  const context = { models, providers, enabled, activeProvider };

  const configured = settings?.configured === true;
  const off = disabled === true || !configured;
  // What Settings points at, by its label when the list knows it and by its
  // id when it does not — a model the provider has stopped offering still has
  // a name worth showing.
  const settingsModel = settings?.modelId ?? null;
  const settingsLabel =
    models.find((model) => model.provider === activeProvider && model.modelId === settingsModel)?.label ??
    settingsModel ??
    'not set';
  const activePlace = providers.find((entry) => entry.id === activeProvider) ?? null;
  const defaultWhere = activePlace === null ? null : whereItRuns(activePlace);
  let label: string;
  if (value === null) {
    label = defaultWhere === null ? `Default · ${settingsLabel}` : `Default · ${settingsLabel} · ${defaultWhere}`;
  } else {
    const described = describeModel(value, context);
    label = [described.name, described.where, described.problem].filter((part) => part !== null).join(' · ');
  }

  const choose = (next: string | null): void => {
    setOpen(false);
    const after = isLocal(next, context);
    const nextProvider =
      next === null ? activeProvider : findModel(next, models, activeProvider, providers.map((entry) => entry.id)).provider;
    setNotice(
      moveLine(isLocal(value, context), after, providers.find((entry) => entry.id === nextProvider)?.label ?? null) ?? notice,
    );
    onChange(next);
  };

  return (
    <span className="broapp-chat-picker__wrap">
      <Popover.Root onOpenChange={setOpen} open={open}>
        <Popover.Trigger
          className="broapp-chat-picker"
          disabled={off}
          // A `title` rather than the vendored tooltip: one sentence on a
          // disabled control needs no popover of its own, and a disabled button
          // never fires the events a tooltip listens for.
          title={off ? NOT_CONFIGURED : label}
          type="button"
        >
          <span className="broapp-chat-picker__label">{label}</span>
          <ChevronDown aria-hidden="true" size={14} />
        </Popover.Trigger>
        {/*
          No portal: the panel stays inside `.broapp-chat`, where the tokens it
          is painted with are defined, and a page that renders the panel inside
          an overflow-hidden column still sees it.
        */}
        <Popover.Content align="start" className="broapp-chat-picker__panel" sideOffset={6}>
          <BroappModelList
            activeProvider={activeProvider}
            defaultLabel={settingsLabel}
            defaultWhere={defaultWhere}
            error={error === null ? null : error.message}
            loading={pending}
            models={models}
            onChange={choose}
            providers={providers}
            unavailable={unavailable}
            value={value}
          />
        </Popover.Content>
      </Popover.Root>
      {notice === null ? null : (
        <span className="broapp-chat-picker__notice" role="status">
          {notice}
        </span>
      )}
    </span>
  );
}
