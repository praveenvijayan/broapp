/**
 * The backlog of the application the person has selected.
 *
 * Each request a person made, what the engineer understood it to be, and the
 * tasks it was split into, in the order they would run. A person can choose
 * the model a task runs on, remove a task nothing depends on, withdraw a
 * request that is not running, and choose a model for each tier. Nothing here
 * runs anything, and nothing here edits a task's text: a plan is the engineer's
 * to write and the person's to accept or remove.
 *
 * Like the Knowledge panel it refreshes when it opens and when Refresh is
 * pressed, never on a timer, so a row does not move while somebody reads it.
 *
 * The drawing is split from the reading. The components that draw take rows
 * and callbacks; the live panel fetches the rows. A test draws the same
 * components from rows it made, without a connection.
 */
import { useCallback, useEffect, useState } from 'react';

import { useAiModels } from 'broapp/ai/react';
import type { AiModelsHook } from 'broapp/ai/react';
import { useOperation } from 'broapp/react';
import type { OperationOutput } from 'broapp/shared';

import type { LauncherContract } from '../contract.ts';

type IntentSummary = OperationOutput<LauncherContract, 'launcher.intentsList'>['intents'][number];
type IntentDetail = OperationOutput<LauncherContract, 'launcher.intentGet'>;
type Task = IntentDetail['tasks'][number];
type TierModels = OperationOutput<LauncherContract, 'launcher.intentModelsGet'>;
type Model = AiModelsHook['models'][number];

/** What the panel says with no application selected. */
export const BACKLOG_NO_APP = 'Choose an application to see its backlog.';
/** What it says when an application has no intents. */
export const BACKLOG_EMPTY = 'Nothing has been planned yet. Ask the engineer for a change with more than one part.';
/** What it says under a model select when the provider's list could not be read. */
export const MODELS_UNREADABLE = 'The model list could not be read, so only the current choice is shown.';

/** The statuses whose model a person may still choose, as the store holds them. */
const MODEL_EDITABLE = new Set(['proposed', 'in-queue', 'failed', 'interrupted']);
const REMOVABLE = new Set(['proposed', 'in-queue']);

/** `12 Sep 13:04`, local time. */
function when(at: number): string {
  const date = new Date(at);
  const month = date.toLocaleString('en', { month: 'short' });
  const time = [date.getHours(), date.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${String(date.getDate())} ${month} ${time}`;
}

/** Which of the four colour pairs a status is drawn in. */
function tone(status: string): 'good' | 'warn' | 'error' | 'quiet' {
  if (status === 'completed' || status === 'done') return 'good';
  if (status === 'failed') return 'error';
  if (status === 'in-progress' || status === 'needs-answer' || status === 'interrupted' || status === 'running' || status === 'stopped') {
    return 'warn';
  }
  return 'quiet';
}

function Chip({ word, title }: { word: string; title?: string }): React.ReactElement {
  return (
    <span className={`launcher__k-chip launcher__k-chip--${tone(word)}`} title={title}>
      {word}
    </span>
  );
}

// ── The frame ───────────────────────────────────────────────────────────────

function Frame({
  onClose,
  onRefresh,
  children,
}: {
  onClose(): void;
  onRefresh?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <aside aria-label="Backlog" className="launcher__logs launcher__k launcher__intent">
      <div className="launcher__settings-header">
        <h2 className="launcher__card-title">Backlog</h2>
        <div className="launcher__row-actions">
          {onRefresh === undefined ? null : (
            <button className="launcher__button launcher__button--small" onClick={onRefresh} type="button">
              Refresh
            </button>
          )}
          <button className="launcher__button launcher__button--small" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
      {children}
    </aside>
  );
}

// ── Drawing: rows in, callbacks out ─────────────────────────────────────────

/** The models a task may be given: the provider's, able to call tools. */
function toolModels(models: readonly Model[]): Model[] {
  return models.filter((model) => model.capabilities.tools);
}

/** A model `<select>`, keeping the current value even when the list has not got it. */
function ModelSelect({
  label,
  value,
  models,
  unreadable,
  disabled,
  first,
  onChange,
}: {
  label: string;
  value: string | null;
  models: readonly Model[];
  unreadable: boolean;
  disabled: boolean;
  first: string;
  onChange(modelId: string | null): void;
}): React.ReactElement {
  const offered = toolModels(models);
  const missing = value !== null && !offered.some((model) => model.modelId === value);
  return (
    <span className="launcher__intent-model">
      <select
        aria-label={label}
        className="launcher__input launcher__intent-select"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        value={value ?? ''}
      >
        <option value="">{first}</option>
        {missing ? <option value={value}>{value}</option> : null}
        {offered.map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.label}
          </option>
        ))}
      </select>
      {unreadable ? <span className="launcher__intent-note">{MODELS_UNREADABLE}</span> : null}
    </span>
  );
}

export interface TierModelsBlockProps {
  readonly value: TierModels | null;
  readonly models: readonly Model[];
  readonly unreadable: boolean;
  readonly error: string | null;
  onChange(next: TierModels): void;
}

/** The three tier models, collapsed until somebody wants them. */
export function TierModelsBlock({ value, models, unreadable, error, onChange }: TierModelsBlockProps): React.ReactElement {
  const tiers = ['light', 'standard', 'deep'] as const;
  return (
    <details className="launcher__intent-tiers">
      <summary className="launcher__intent-summary">Models by tier</summary>
      <p className="launcher__lede">
        A task runs on its own model when one is chosen, otherwise on its tier&apos;s, otherwise on the model chosen in
        Settings.
      </p>
      {value === null ? (
        <p className="launcher__lede">Reading the tier models…</p>
      ) : (
        <div className="launcher__intent-tier-list">
          {tiers.map((tier) => (
            <label className="launcher__log-control" key={tier}>
              {tier}
              <ModelSelect
                disabled={false}
                first="Settings model"
                label={`Model for ${tier} tasks`}
                models={models}
                onChange={(modelId) => onChange({ ...value, [tier]: modelId })}
                unreadable={unreadable}
                value={value[tier]}
              />
            </label>
          ))}
        </div>
      )}
      {error === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

export interface TaskRowProps {
  readonly task: Task;
  readonly tierModel: string | null;
  readonly models: readonly Model[];
  readonly unreadable: boolean;
  readonly open: boolean;
  onToggle(): void;
  onModel(modelId: string | null): void;
  /** What is shown when the row is open. */
  readonly children?: React.ReactNode;
}

/** One task: slug, title, priority, tier, model, status, and what it waits on. */
export function TaskRow({ task, tierModel, models, unreadable, open, onToggle, onModel, children }: TaskRowProps): React.ReactElement {
  return (
    <li className="launcher__log-row launcher__intent-task">
      <div className="launcher__intent-line">
        <button aria-expanded={open} className="launcher__intent-open" onClick={onToggle} type="button">
          <span className="launcher__log-time">{task.slug}</span>
          <span className="launcher__k-text">{task.title}</span>
        </button>
        <span className="launcher__k-chips">
          <Chip title="priority" word={task.priority} />
          <Chip title={task.tierReasons.join(' ')} word={task.tier} />
          <Chip word={task.status} />
          {task.status === 'blocked' ? (
            <span className="launcher__intent-blocked">{`blocked by ${task.waitingOn.join(', ')}`}</span>
          ) : null}
        </span>
        <ModelSelect
          disabled={!MODEL_EDITABLE.has(task.stored)}
          first={tierModel === null ? 'Settings model' : `${task.tier} tier: ${tierModel}`}
          label={`Model for ${task.slug}`}
          models={models}
          onChange={onModel}
          unreadable={unreadable}
          value={task.modelOverride}
        />
      </div>
      {open ? children : null}
    </li>
  );
}

export interface TaskDetailViewProps {
  readonly task: Task;
  readonly markdown: string | null;
  readonly planError: string | null;
  readonly removeError: string | null;
  onRemove(): void;
}

/** An open task: its plan, its history, and Remove. */
export function TaskDetailView({ task, markdown, planError, removeError, onRemove }: TaskDetailViewProps): React.ReactElement {
  const [asking, setAsking] = useState(false);
  return (
    <div className="launcher__k-detail">
      {planError === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {planError}
        </p>
      )}
      {markdown === null && planError === null ? <p className="launcher__lede">Reading the plan…</p> : null}
      {markdown === null ? null : <pre className="launcher__log-data launcher__intent-plan">{markdown}</pre>}
      <h3 className="launcher__k-heading">History</h3>
      <ol className="launcher__list">
        {task.events.map((event) => (
          <li key={event.id}>
            {when(event.at)} · {event.from ?? 'new'} → {event.to}
            {event.note === '' ? '' : ` · ${event.note}`}
          </li>
        ))}
      </ol>
      {REMOVABLE.has(task.stored) ? (
        asking ? (
          <div className="launcher__row-actions">
            <span>Remove {task.slug}? It will not run, and its plan stays in the history.</span>
            <button
              className="launcher__button launcher__button--small"
              onClick={() => {
                setAsking(false);
                onRemove();
              }}
              type="button"
            >
              Remove
            </button>
            <button className="launcher__button launcher__button--small" onClick={() => setAsking(false)} type="button">
              Cancel
            </button>
          </div>
        ) : (
          <div className="launcher__row-actions">
            <button className="launcher__button launcher__button--small" onClick={() => setAsking(true)} type="button">
              Remove
            </button>
          </div>
        )
      ) : null}
      {removeError === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {removeError}
        </p>
      )}
    </div>
  );
}

/** One block of the analysis, or nothing when it is empty. */
function Block({ title, items }: { title: string; items: readonly string[] }): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <>
      <dt>{title}</dt>
      <dd>
        <ul className="launcher__list">
          {items.map((item, index) => (
            <li key={`${String(index)}-${item.slice(0, 20)}`}>{item}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}

export interface IntentDetailViewProps {
  readonly detail: IntentDetail;
  readonly tierModels: TierModels | null;
  readonly models: readonly Model[];
  readonly unreadable: boolean;
  readonly withdrawError: string | null;
  readonly modelError: string | null;
  onWithdraw(): void;
  onModel(taskId: number, modelId: string | null): void;
  /** The open task's detail. Absent, rows do not open. */
  renderTask?(task: Task): React.ReactNode;
}

/** An open intent: the request, the analysis, Withdraw, and the tasks in run order. */
export function IntentDetailView({
  detail,
  tierModels,
  models,
  unreadable,
  withdrawError,
  modelError,
  onWithdraw,
  onModel,
  renderTask,
}: IntentDetailViewProps): React.ReactElement {
  const { intent, tasks } = detail;
  const [asking, setAsking] = useState(false);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const analysed =
    intent.restated !== null ||
    intent.fits !== null ||
    intent.conflicts.length + intent.outOfReach.length + intent.assumptions.length + intent.questions.length > 0;
  const withdrawable = intent.status === 'draft' || intent.status === 'stopped';

  return (
    <div className="launcher__k-detail">
      <p className="launcher__k-quote">{intent.request}</p>
      {analysed ? (
        <dl className="launcher__k-fields">
          {intent.restated === null ? null : (
            <>
              <dt>Restated</dt>
              <dd>{intent.restated}</dd>
            </>
          )}
          {intent.fits === null ? null : (
            <>
              <dt>Builds on</dt>
              <dd>{intent.fits}</dd>
            </>
          )}
          <Block items={intent.conflicts} title="Conflicts" />
          <Block items={intent.outOfReach} title="Out of reach" />
          <Block items={intent.assumptions} title="Assumptions" />
          <Block items={intent.questions} title="Open questions" />
        </dl>
      ) : null}

      {withdrawable ? (
        asking ? (
          <div className="launcher__row-actions">
            <span>Withdraw this request? Every task it has not completed is removed.</span>
            <button
              className="launcher__button launcher__button--small"
              onClick={() => {
                setAsking(false);
                onWithdraw();
              }}
              type="button"
            >
              Withdraw
            </button>
            <button className="launcher__button launcher__button--small" onClick={() => setAsking(false)} type="button">
              Cancel
            </button>
          </div>
        ) : (
          <div className="launcher__row-actions">
            <button className="launcher__button launcher__button--small" onClick={() => setAsking(true)} type="button">
              Withdraw
            </button>
          </div>
        )
      ) : null}
      {withdrawError === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {withdrawError}
        </p>
      )}
      {modelError === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {modelError}
        </p>
      )}

      <h3 className="launcher__k-heading">Tasks, in the order they run</h3>
      {tasks.length === 0 ? <p className="launcher__empty">This request has no tasks yet.</p> : null}
      <ol className="launcher__log-list launcher__k-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            models={models}
            onModel={(modelId) => onModel(task.id, modelId)}
            onToggle={() => setOpenTask(openTask === task.id ? null : task.id)}
            open={renderTask !== undefined && openTask === task.id}
            task={task}
            tierModel={tierModels === null ? null : tierModels[task.tier]}
            unreadable={unreadable}
          >
            {renderTask?.(task)}
          </TaskRow>
        ))}
      </ol>
    </div>
  );
}

/** A request's row: when, status, what it is, and how its tasks stand. */
function IntentLine({ intent, open, onToggle }: { intent: IntentSummary; open: boolean; onToggle(): void }): React.ReactElement {
  const counts = Object.entries(intent.counts).filter(([status, n]) => n > 0 && status !== 'removed');
  return (
    <button aria-expanded={open} className="launcher__k-line" onClick={onToggle} type="button">
      <span className="launcher__log-time">{when(intent.createdAt)}</span>
      <span className="launcher__k-chips">
        <Chip word={intent.status} />
      </span>
      <span className="launcher__k-text">{intent.restated}</span>
      <span className="launcher__k-counts">
        {counts.length === 0 ? 'no tasks' : counts.map(([status, n]) => `${String(n)} ${status}`).join(' · ')}
      </span>
    </button>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

/** Rows to draw instead of reading them: what a test passes. */
export interface BacklogSnapshot {
  readonly intents: readonly IntentSummary[];
  /** An intent drawn open. */
  readonly opened?: IntentDetail;
}

export interface IntentPanelProps {
  /** The application whose backlog is shown; `null` when none is selected. */
  readonly appId: string | null;
  onClose(): void;
  /** Draw only the frame and this sentence: a launcher's refusal. */
  readonly error?: string;
  /** Draw these rows rather than reading them. The tab passes nothing. */
  readonly snapshot?: BacklogSnapshot;
}

export function IntentPanel({ appId, onClose, error, snapshot }: IntentPanelProps): React.ReactElement {
  if (error !== undefined) {
    return (
      <Frame onClose={onClose}>
        <p className="launcher__message launcher__message--error" role="alert">
          {error}
        </p>
      </Frame>
    );
  }
  if (appId === null) {
    return (
      <Frame onClose={onClose}>
        <p className="launcher__lede">{BACKLOG_NO_APP}</p>
      </Frame>
    );
  }
  if (snapshot !== undefined) {
    const openedId = snapshot.opened?.intent.id ?? null;
    return (
      <Frame onClose={onClose}>
        <div className="launcher__k-body">
          {snapshot.intents.length === 0 ? <p className="launcher__lede">{BACKLOG_EMPTY}</p> : null}
          <ol className="launcher__log-list launcher__k-list">
            {snapshot.intents.map((intent) => (
              <li className="launcher__log-row" key={intent.id}>
                <IntentLine intent={intent} onToggle={() => undefined} open={intent.id === openedId} />
                {snapshot.opened !== undefined && intent.id === openedId ? (
                  <IntentDetailView
                    detail={snapshot.opened}
                    modelError={null}
                    models={[]}
                    onModel={() => undefined}
                    onWithdraw={() => undefined}
                    tierModels={null}
                    unreadable={false}
                    withdrawError={null}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </Frame>
    );
  }
  return <LiveIntentPanel appId={appId} onClose={onClose} />;
}

// ── Reading: the live panel ─────────────────────────────────────────────────

function LiveIntentPanel({ appId, onClose }: { appId: string; onClose(): void }): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.intentsList'>('launcher.intentsList');
  const tierGet = useOperation<LauncherContract, 'launcher.intentModelsGet'>('launcher.intentModelsGet');
  const tierSet = useOperation<LauncherContract, 'launcher.intentModelsSet'>('launcher.intentModelsSet');
  const models = useAiModels();
  const [reload, setReload] = useState(0);
  const [opened, setOpened] = useState<number | null>(null);

  const { run } = list;
  const { run: readTiers } = tierGet;
  useEffect(() => {
    void run({ appId, limit: 100 });
    void readTiers(undefined);
  }, [run, readTiers, appId, reload]);
  // Another application's backlog has nothing open.
  useEffect(() => setOpened(null), [appId]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const intents = list.data?.intents ?? [];
  const tiers = tierSet.data ?? tierGet.data;

  return (
    <Frame onClose={onClose} onRefresh={refresh}>
      <div className="launcher__k-body">
        <TierModelsBlock
          error={tierSet.error?.message ?? tierGet.error?.message ?? null}
          models={models.models}
          onChange={(next) => void tierSet.run(next).then(refresh)}
          unreadable={models.error !== null}
          value={tiers}
        />
        {list.error !== null ? (
          <p className="launcher__message launcher__message--error" role="alert">
            {list.error.message}
          </p>
        ) : null}
        {list.pending && list.data === null ? <p className="launcher__lede">Reading the backlog…</p> : null}
        {list.data !== null && intents.length === 0 ? <p className="launcher__lede">{BACKLOG_EMPTY}</p> : null}
        <ol className="launcher__log-list launcher__k-list">
          {intents.map((intent) => (
            <li className="launcher__log-row" key={intent.id}>
              <IntentLine
                intent={intent}
                onToggle={() => setOpened(opened === intent.id ? null : intent.id)}
                open={opened === intent.id}
              />
              {opened === intent.id ? (
                <LiveIntentDetail
                  id={intent.id}
                  models={models.models}
                  onChanged={refresh}
                  reload={reload}
                  tierModels={tiers}
                  unreadable={models.error !== null}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </Frame>
  );
}

function LiveIntentDetail({
  id,
  reload,
  tierModels,
  models,
  unreadable,
  onChanged,
}: {
  id: number;
  reload: number;
  tierModels: TierModels | null;
  models: readonly Model[];
  unreadable: boolean;
  onChanged(): void;
}): React.ReactElement {
  const detail = useOperation<LauncherContract, 'launcher.intentGet'>('launcher.intentGet');
  const withdraw = useOperation<LauncherContract, 'launcher.intentWithdraw'>('launcher.intentWithdraw');
  const setModel = useOperation<LauncherContract, 'launcher.intentTaskModel'>('launcher.intentTaskModel');
  const { run } = detail;
  useEffect(() => {
    void run({ id });
  }, [run, id, reload]);

  if (detail.error !== null) {
    return (
      <p className="launcher__message launcher__message--error" role="alert">
        {detail.error.message}
      </p>
    );
  }
  if (detail.data === null) return <p className="launcher__lede">Reading the request…</p>;
  return (
    <IntentDetailView
      detail={detail.data}
      modelError={setModel.error?.message ?? null}
      models={models}
      onModel={(taskId, modelId) => void setModel.run({ taskId, modelId }).then(onChanged)}
      onWithdraw={() => void withdraw.run({ id }).then(onChanged)}
      renderTask={(task) => <LiveTaskDetail onChanged={onChanged} task={task} />}
      tierModels={tierModels}
      unreadable={unreadable}
      withdrawError={withdraw.error?.message ?? null}
    />
  );
}

function LiveTaskDetail({ task, onChanged }: { task: Task; onChanged(): void }): React.ReactElement {
  const plan = useOperation<LauncherContract, 'launcher.intentPlan'>('launcher.intentPlan');
  const remove = useOperation<LauncherContract, 'launcher.intentTaskRemove'>('launcher.intentTaskRemove');
  const { run } = plan;
  useEffect(() => {
    void run({ taskId: task.id });
  }, [run, task.id, task.stored]);
  return (
    <TaskDetailView
      markdown={plan.data?.markdown ?? null}
      onRemove={() => void remove.run({ taskId: task.id }).then(onChanged)}
      planError={plan.error?.message ?? null}
      removeError={remove.error?.message ?? null}
      task={task}
    />
  );
}
