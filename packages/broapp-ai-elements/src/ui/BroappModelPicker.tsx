/**
 * Which model this conversation talks to.
 *
 * The first row is "Default (follow Settings)", because a conversation that
 * follows Settings is the normal case and pinning one to a model is the
 * exception. The provider is never offered here: choosing one decides which
 * key is used and whether anything leaves the computer, which is a Settings
 * decision rather than a per-conversation one.
 */
import * as React from 'react';

import { Check, ChevronDown, Eye } from 'lucide-react';
import { Popover } from 'radix-ui';

import type { BroappModel } from 'broapp/ai';
import { useAiContext, useAiModels } from 'broapp/ai/react';

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
  /** The model this conversation is pinned to. Null follows Settings. */
  readonly value: string | null;
  onChange(modelId: string | null): void;
  readonly disabled?: boolean;
}

/** Props for {@link BroappModelList}. */
export interface BroappModelListProps {
  readonly models: readonly BroappModel[];
  readonly value: string | null;
  /** What the "Default" row says Settings currently points at. */
  readonly defaultLabel: string;
  onChange(modelId: string | null): void;
  readonly loading?: boolean;
  readonly error?: string | null;
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
  onChange,
  loading,
  error,
}: BroappModelListProps): React.ReactElement {
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
            <span className="broapp-chat-option__muted">{defaultLabel}</span>
            {value === null ? <Check aria-label="Current" size={15} /> : null}
          </CommandItem>
          {models.map((model) => (
            <CommandItem
              className="broapp-chat-option"
              key={`${model.provider}/${model.modelId}`}
              onSelect={() => onChange(model.modelId)}
              value={`${model.modelId} ${model.label} ${model.provider}`}
            >
              <Mark provider={model.provider} />
              <span className="broapp-chat-option__label">{model.label}</span>
              {model.capabilities.vision ? (
                <span className="broapp-chat-option__badge">
                  <Eye aria-hidden="true" size={12} />
                  vision
                </span>
              ) : null}
              {model.modelId === value ? <Check aria-label="Current" size={15} /> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

export function BroappModelPicker({
  value,
  onChange,
  disabled,
}: BroappModelPickerProps): React.ReactElement {
  const { settings } = useAiContext();
  const { models, pending, error } = useAiModels();
  const [open, setOpen] = React.useState(false);

  const configured = settings?.configured === true;
  const off = disabled === true || !configured;
  // What Settings points at, by its label when the list knows it and by its
  // id when it does not — a model the provider has stopped offering still has
  // a name worth showing.
  const settingsModel = settings?.modelId ?? null;
  const settingsLabel =
    models.find((model) => model.modelId === settingsModel)?.label ?? settingsModel ?? 'not set';
  const pinned = models.find((model) => model.modelId === value) ?? null;
  const label = value === null ? `Default · ${settingsLabel}` : (pinned?.label ?? value);

  return (
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
          defaultLabel={settingsLabel}
          error={error === null ? null : error.message}
          loading={pending}
          models={models}
          onChange={(modelId) => {
            setOpen(false);
            onChange(modelId);
          }}
          value={value}
        />
      </Popover.Content>
    </Popover.Root>
  );
}
