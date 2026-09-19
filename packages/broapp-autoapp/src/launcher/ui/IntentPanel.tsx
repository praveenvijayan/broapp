/**
 * The backlog of the application the person has selected.
 *
 * Each request a person made, what the engineer understood it to be, and the
 * tasks it was split into, in the order they would run. A person can choose
 * the model a task runs on, remove a task nothing depends on, withdraw a
 * request that is not running, choose a model for each tier, and run a
 * reviewed backlog or stop it. Nothing here edits a task's text: a plan is the
 * engineer's to write and the person's to accept or remove.
 *
 * It reads when it opens and when Refresh is pressed, and every two seconds
 * only while something is moving: a chat turn is running, the open request is
 * still being written, or a run is going. Otherwise a row does not move while
 * somebody reads it.
 *
 * The drawing is split from the reading. The components that draw take rows
 * and callbacks; the live panel fetches the rows. A test draws the same
 * components from rows it made, without a connection.
 */
import { useCallback, useEffect, useState } from 'react';

import { useAiModels, useAiSettings } from 'broapp/ai/react';
import type { AiContract, AiModelsHook } from 'broapp/ai/react';
import { useOperation } from 'broapp/react';
import { countdown, isUrgent } from 'broapp/shared';
import type { OperationOutput } from 'broapp/shared';

import type { LauncherContract } from '../contract.ts';

type IntentSummary = OperationOutput<LauncherContract, 'launcher.intentsList'>['intents'][number];
type IntentDetail = OperationOutput<LauncherContract, 'launcher.intentGet'>;
type Task = IntentDetail['tasks'][number];
type TierModels = OperationOutput<LauncherContract, 'launcher.intentModelsGet'>;
type Model = AiModelsHook['models'][number];
type Run = NonNullable<IntentDetail['run']>;
type Question = NonNullable<Run['question']>;

/** What the panel says with no application selected. */
export const BACKLOG_NO_APP = 'Choose an application to see its backlog.';
/** What it says when an application has no intents. */
export const BACKLOG_EMPTY = 'Nothing has been planned yet. Ask the engineer for a change with more than one part.';
/** Beside a draft's status while the engineer is still writing its plan. */
export const BEING_WRITTEN = 'Being written';
/** The heading over a draft's open questions, which come before everything else. */
export const NEEDS_ANSWERS = 'The engineer needs answers';
/** Where those answers go. */
export const ANSWER_IN_CHAT = 'Answer in the chat. The engineer folds your answers into the plan and carries on from there.';
/**
 * What starting a run agrees to, asked before Run does anything.
 *
 * The engineer's `intent.start` says the same in its description, which is
 * what the chat's question shows; a test holds the two equal, because the page
 * cannot import host code.
 */
export const RUN_CONFIRMATION =
  'Until it finishes or is stopped, edits, builds and previews for its application are approved without asking. Anything else is put to you in the Backlog panel and waits. Activation is never approved this way.';
/** What a finished backlog says. The executor's `RUN_FINISHED`; a test holds them equal. */
export const RUN_DONE =
  'All tasks are built and checked in the candidate. Open the preview, look, then activate from the Candidate panel.';
/** Under a failed task's reasons and advice. */
export const FAILED_NEXT = 'Run again to retry, or ask the engineer to revise this task.';
/** The heading over the runbook lines of a finished backlog. */
export const BY_HAND = 'For you to check by hand';
/**
 * Under {@link RUN_DONE} when a line below names a route that reaches outside
 * the machine: a preview refuses one for everyone, the person included.
 */
export const AFTER_ACTIVATING =
  'Lines marked “after activating” name a route that reaches outside this machine. A preview refuses it, even for you, so try those only once the release is activated.';
/** Over a question the run brought to the person. */
export const RUN_ASKS = 'The run needs your answer before it goes on';

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

/** A model as the list names it, or its id when the list has not got it. */
function modelName(modelId: string, models: readonly Model[]): string {
  return models.find((model) => model.modelId === modelId)?.label ?? modelId;
}

/**
 * What a select's empty choice runs on, by name: the tier's model when the tier
 * has one, otherwise the model chosen in Settings. A person choosing a model
 * has to see which one they would be choosing instead of.
 */
export function inheritedModel(
  tier: { readonly name: string; readonly model: string | null } | null,
  settingsModel: string | null,
  models: readonly Model[],
): string {
  if (tier !== null && tier.model !== null) return `${tier.name} tier: ${modelName(tier.model, models)}`;
  return settingsModel === null ? 'Settings model' : `Settings: ${modelName(settingsModel, models)}`;
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
  /** The model chosen in Settings, which a tier with none runs on. */
  readonly settingsModel?: string | null;
  readonly unreadable: boolean;
  readonly error: string | null;
  onChange(next: TierModels): void;
}

/** The three tier models, collapsed until somebody wants them. */
export function TierModelsBlock({ value, models, settingsModel = null, unreadable, error, onChange }: TierModelsBlockProps): React.ReactElement {
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
                first={inheritedModel(null, settingsModel, models)}
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

/** A text box and Answer: a builder's question, or the advice that asks the person. */
export function AnswerBox({ label, onAnswer }: { label: string; onAnswer(answer: string): void }): React.ReactElement {
  const [text, setText] = useState('');
  const answer = text.trim();
  return (
    <div className="launcher__intent-answer">
      <textarea
        aria-label={label}
        className="launcher__input launcher__intent-answer-text"
        maxLength={1_000}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        value={text}
      />
      <button
        className="launcher__button launcher__button--small"
        disabled={answer === ''}
        onClick={() => {
          onAnswer(answer);
          setText('');
        }}
        type="button"
      >
        Answer
      </button>
    </div>
  );
}

/** The reasons a failed task gave, as stored. */
function reasonsOf(failure: unknown): readonly string[] {
  const reasons = (failure as { reasons?: unknown } | null)?.reasons;
  return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string') : [];
}

/** The main model's advice on a failed task, when it gave any. */
function adviceOf(advice: unknown): { diagnosis: string; advice: string; note: string } | null {
  const value = advice as { diagnosis?: unknown; advice?: unknown; note?: unknown } | null;
  if (typeof value?.diagnosis !== 'string' || typeof value.advice !== 'string' || typeof value.note !== 'string') return null;
  return { diagnosis: value.diagnosis, advice: value.advice, note: value.note };
}

/** How long ago, in words a person reads at a glance. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  return seconds < 60 ? `${String(seconds)}s ago` : `${String(Math.round(seconds / 60))} min ago`;
}

/** What the run says about one task, under its row: never hidden behind a click. */
function TaskState({
  task,
  run,
  onAnswer,
}: {
  task: Task;
  run: Run | null;
  onAnswer?: ((answer: string) => void) | undefined;
}): React.ReactElement | null {
  if (task.stored === 'in-progress' && run !== null && run.taskId === task.id) {
    return (
      <p className="launcher__intent-note launcher__intent-state">
        {`Working, turn ${String(run.attempt)}: `}
        {run.lastTool === null || run.lastToolAt === null ? 'starting' : `${run.lastTool}, ${ago(run.lastToolAt, Date.now())}`}
        {run.approvals > 0 ? ` · ${String(run.approvals)} approvals` : ''}
      </p>
    );
  }
  if (task.stored === 'completed') {
    return (
      <p className="launcher__intent-note launcher__intent-state">
        {`Estimated ${String(task.estimatedLines)} lines, changed ${task.actualLines === null ? 'an unknown number' : String(task.actualLines)}.`}
      </p>
    );
  }
  if (task.stored === 'needs-answer' && task.question !== null) {
    return (
      <div className="launcher__intent-ask">
        <p className="launcher__k-quote">{task.question}</p>
        {onAnswer === undefined ? null : <AnswerBox label={`Answer for ${task.slug}`} onAnswer={onAnswer} />}
      </div>
    );
  }
  if (task.stored === 'failed') {
    const reasons = reasonsOf(task.failure);
    const advice = adviceOf(task.advice);
    return (
      <div className="launcher__intent-failure">
        {reasons.length === 0 ? null : (
          <ul className="launcher__list">
            {reasons.map((reason, index) => (
              <li key={`${String(index)}-${reason.slice(0, 20)}`}>{reason}</li>
            ))}
          </ul>
        )}
        {advice === null ? null : (
          <p className="launcher__intent-advice">
            <strong>{`Advice: ${advice.advice}.`}</strong> {advice.diagnosis} {advice.note}
          </p>
        )}
        <p className="launcher__lede">{FAILED_NEXT}</p>
        {advice?.advice === 'ask' && onAnswer !== undefined ? (
          <AnswerBox label={`Answer about ${task.slug}`} onAnswer={onAnswer} />
        ) : null}
      </div>
    );
  }
  return null;
}

export interface TaskRowProps {
  readonly task: Task;
  /** Where the run is, when one is going. */
  readonly run?: Run | null;
  /** Answer the task's question, or the advice that asks. */
  onAnswer?(answer: string): void;
  readonly tierModel: string | null;
  /** The model chosen in Settings, which a task with no other model runs on. */
  readonly settingsModel?: string | null;
  readonly models: readonly Model[];
  readonly unreadable: boolean;
  readonly open: boolean;
  onToggle(): void;
  onModel(modelId: string | null): void;
  /** What is shown when the row is open. */
  readonly children?: React.ReactNode;
}

/** One task: slug, title, priority, tier, model, status, and what it waits on. */
export function TaskRow({
  task,
  run = null,
  onAnswer,
  tierModel,
  settingsModel = null,
  models,
  unreadable,
  open,
  onToggle,
  onModel,
  children,
}: TaskRowProps): React.ReactElement {
  return (
    <li className="launcher__log-row launcher__intent-task">
      <div className="launcher__intent-line">
        <button aria-expanded={open} className="launcher__intent-open" onClick={onToggle} type="button">
          <span className="launcher__intent-title">{task.title}</span>
          <span className="launcher__intent-slug">{task.slug}</span>
        </button>
        <span className="launcher__k-chips launcher__intent-chips">
          <Chip word={task.status} />
          <Chip title="priority" word={task.priority} />
          <Chip title={task.tierReasons.join(' ')} word={task.tier} />
        </span>
        <ModelSelect
          disabled={!MODEL_EDITABLE.has(task.stored)}
          first={inheritedModel({ name: task.tier, model: tierModel }, settingsModel, models)}
          label={`Model for ${task.slug}`}
          models={models}
          onChange={onModel}
          unreadable={unreadable}
          value={task.modelOverride}
        />
      </div>
      {task.status === 'blocked' ? (
        <p className="launcher__intent-note launcher__intent-state launcher__intent-blocked">{`blocked by ${task.waitingOn.join(', ')}`}</p>
      ) : null}
      <TaskState onAnswer={onAnswer} run={run} task={task} />
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

/** A question the run brought to the person: what would run, how long is left, and the two answers. */
export function RunQuestionView({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer(approve: boolean): void;
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const urgent = isUrgent(question.expiresAt, now);
  return (
    <section aria-label={RUN_ASKS} className="launcher__intent-questions" role="alert">
      <h3 className="launcher__k-heading">{RUN_ASKS}</h3>
      <p className="launcher__lede">
        {`A builder wants to run ${question.tool}. The run does not answer this one for you.`}
      </p>
      <pre className="launcher__log-data">{JSON.stringify(question.input, null, 2)}</pre>
      <div className="launcher__row-actions">
        <button className="launcher__button launcher__button--small" onClick={() => onAnswer(true)} type="button">
          Approve
        </button>
        <button className="launcher__button launcher__button--small" onClick={() => onAnswer(false)} type="button">
          Deny
        </button>
        <span className={urgent ? 'launcher__intent-urgent' : 'launcher__intent-note'}>
          {`expires in ${countdown(question.expiresAt, now)}`}
        </span>
      </div>
    </section>
  );
}

/** An inline confirmation: the question, the act, and Cancel. */
function Confirming({
  label,
  question,
  onConfirm,
}: {
  label: string;
  question: string;
  onConfirm(): void;
}): React.ReactElement {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className="launcher__button launcher__button--small" onClick={() => setAsking(true)} type="button">
        {label}
      </button>
    );
  }
  return (
    <div className="launcher__row-actions launcher__intent-confirm">
      <span>{question}</span>
      <button
        className="launcher__button launcher__button--small"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        type="button"
      >
        {label}
      </button>
      <button className="launcher__button launcher__button--small" onClick={() => setAsking(false)} type="button">
        Cancel
      </button>
    </div>
  );
}

export interface IntentDetailViewProps {
  readonly detail: IntentDetail;
  /** A refusal from Run, Stop or an answer, as a sentence. */
  readonly runError?: string | null;
  onRun?(): void;
  onStop?(): void;
  onAnswer?(taskId: number, answer: string): void;
  onConfirm?(question: Question, approve: boolean): void;
  readonly tierModels: TierModels | null;
  readonly settingsModel?: string | null;
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
  settingsModel = null,
  models,
  unreadable,
  withdrawError,
  modelError,
  onWithdraw,
  onModel,
  renderTask,
  runError = null,
  onRun,
  onStop,
  onAnswer,
  onConfirm,
}: IntentDetailViewProps): React.ReactElement {
  const { intent, tasks, run } = detail;
  const runnable =
    (intent.status === 'draft' && intent.submittedAt !== null && intent.questions.length === 0) || intent.status === 'stopped';
  const byHand = intent.status === 'done' ? tasks.filter((task) => task.stored === 'completed' && task.runbook.length > 0) : [];
  const [asking, setAsking] = useState(false);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const analysed =
    intent.restated !== null ||
    intent.fits !== null ||
    intent.conflicts.length + intent.outOfReach.length + intent.assumptions.length + intent.questions.length > 0;
  const withdrawable = intent.status === 'draft' || intent.status === 'stopped';
  // A draft waiting on the person puts its questions first: nothing else in it
  // moves until they are answered, and the answer goes in the chat.
  const waiting = intent.status === 'draft' && intent.questions.length > 0;

  return (
    <div className="launcher__k-detail launcher__intent-detail">
      <div className="launcher__intent-main">
        {waiting ? (
          <section aria-label={NEEDS_ANSWERS} className="launcher__intent-questions">
            <h3 className="launcher__k-heading">{NEEDS_ANSWERS}</h3>
            <ul className="launcher__list">
              {intent.questions.map((question, index) => (
                <li key={`${String(index)}-${question.slice(0, 20)}`}>{question}</li>
              ))}
            </ul>
            <p className="launcher__lede">{ANSWER_IN_CHAT}</p>
          </section>
        ) : null}
        {run?.question === null || run?.question === undefined ? null : (
          <RunQuestionView onAnswer={(approve) => onConfirm?.(run.question as Question, approve)} question={run.question} />
        )}
        {intent.status === 'stopped' && intent.stopReason !== null ? (
          <p className="launcher__message launcher__message--error" role="status">{`Stopped: ${intent.stopReason}`}</p>
        ) : null}
        {intent.status === 'done' ? (
          <section aria-label="Finished" className="launcher__intent-done">
            <p className="launcher__lede">{RUN_DONE}</p>
            {byHand.some((task) => (task.afterActivating ?? []).length > 0) ? (
              <p className="launcher__lede">{AFTER_ACTIVATING}</p>
            ) : null}
            {byHand.length === 0 ? null : (
              <>
                <h3 className="launcher__k-heading">{BY_HAND}</h3>
                <ul className="launcher__list">
                  {byHand.flatMap((task) =>
                    task.runbook.map((line, index) => (
                      <li key={`${task.slug}-${String(index)}`}>
                        {`${task.slug}: ${line}${(task.afterActivating ?? []).includes(index) ? ' (after activating)' : ''}`}
                      </li>
                    )),
                  )}
                </ul>
              </>
            )}
          </section>
        ) : null}
        <div className="launcher__intent-actions">
          {runnable && onRun !== undefined ? (
            <div className="launcher__row-actions">
              <Confirming
                label="Run"
                onConfirm={onRun}
                question={`Start building this backlog for ${intent.appId}? ${RUN_CONFIRMATION}`}
              />
            </div>
          ) : null}
          {intent.status === 'running' && onStop !== undefined ? (
            <div className="launcher__row-actions">
              <Confirming
                label="Stop"
                onConfirm={onStop}
                question="Stop this run? The task in hand is interrupted and the workspace is left as it is."
              />
            </div>
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
        </div>
        {runError === null ? null : (
          <p className="launcher__message launcher__message--error" role="alert">
            {runError}
          </p>
        )}
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
              run={run}
              {...(onAnswer === undefined ? {} : { onAnswer: (answer: string) => onAnswer(task.id, answer) })}
              models={models}
              onModel={(modelId) => onModel(task.id, modelId)}
              onToggle={() => setOpenTask(openTask === task.id ? null : task.id)}
              open={renderTask !== undefined && openTask === task.id}
              settingsModel={settingsModel}
              task={task}
              tierModel={tierModels === null ? null : tierModels[task.tier]}
              unreadable={unreadable}
            >
              {renderTask?.(task)}
            </TaskRow>
          ))}
        </ol>
      </div>
      <aside aria-label="The request" className="launcher__intent-about">
        <h3 className="launcher__intent-label">Asked for</h3>
        <p className="launcher__intent-request">{intent.request}</p>
        {analysed ? (
          <dl className="launcher__intent-analysis">
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
            {waiting ? null : <Block items={intent.questions} title="Open questions" />}
          </dl>
        ) : null}
      </aside>
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
        {intent.status === 'draft' && intent.submittedAt === null ? (
          <span className="launcher__intent-note">{BEING_WRITTEN}</span>
        ) : null}
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
  /**
   * Whether a chat turn is running. While it is, the list is read again every
   * two seconds, because the engineer may be writing a backlog into it.
   */
  readonly turnActive?: boolean;
  onClose(): void;
  /** Draw only the frame and this sentence: a launcher's refusal. */
  readonly error?: string;
  /** Draw these rows rather than reading them. The tab passes nothing. */
  readonly snapshot?: BacklogSnapshot;
  /** The request to open when the panel opens: the Overview sends a person to one. */
  readonly openIntent?: number | null;
}

export function IntentPanel({ appId, onClose, error, snapshot, turnActive = false, openIntent = null }: IntentPanelProps): React.ReactElement {
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
  return <LiveIntentPanel appId={appId} onClose={onClose} openIntent={openIntent} turnActive={turnActive} />;
}

/**
 * Whether the backlog is moving under somebody's eyes: a chat turn that may be
 * writing it, the open request still being written, or a run going.
 */
export function shouldPoll(
  turnActive: boolean,
  intents: readonly Pick<IntentSummary, 'id' | 'status' | 'submittedAt'>[],
  opened: number | null,
): boolean {
  if (turnActive) return true;
  if (intents.some((intent) => intent.status === 'running')) return true;
  const open = intents.find((intent) => intent.id === opened);
  return open !== undefined && open.status === 'draft' && open.submittedAt === null;
}

/** How often the panel reads again while something is moving. */
const POLL_MS = 2_000;

/**
 * Read again every two seconds while `moving`, and once more when it stops.
 *
 * One timer for the three reasons a backlog moves under somebody's eyes: a
 * chat turn that may be writing it, a draft still being written, a run going.
 * The launcher contract has no stream, and this prompt does not add the first.
 */
function usePolling(moving: boolean, tick: () => void): void {
  const [was, setWas] = useState(moving);
  useEffect(() => {
    if (!moving) return undefined;
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [moving, tick]);
  useEffect(() => {
    if (was && !moving) tick();
    if (was !== moving) setWas(moving);
  }, [moving, was, tick]);
}

// ── Reading: the live panel ─────────────────────────────────────────────────

function LiveIntentPanel({
  appId,
  onClose,
  turnActive,
  openIntent,
}: {
  appId: string;
  onClose(): void;
  turnActive: boolean;
  openIntent: number | null;
}): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.intentsList'>('launcher.intentsList');
  const tierGet = useOperation<LauncherContract, 'launcher.intentModelsGet'>('launcher.intentModelsGet');
  const tierSet = useOperation<LauncherContract, 'launcher.intentModelsSet'>('launcher.intentModelsSet');
  const models = useAiModels();
  const settingsModel = useAiSettings().settings?.modelId ?? null;
  const [reload, setReload] = useState(0);
  const [opened, setOpened] = useState<number | null>(null);

  const { run } = list;
  const { run: readTiers } = tierGet;
  useEffect(() => {
    void run({ appId, limit: 100 });
    void readTiers(undefined);
  }, [run, readTiers, appId, reload]);
  // Another application's backlog has nothing open, unless the person was
  // sent to one of its requests.
  useEffect(() => setOpened(openIntent), [appId, openIntent]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const intents = list.data?.intents ?? [];
  const tiers = tierSet.data ?? tierGet.data;
  usePolling(shouldPoll(turnActive, intents, opened), refresh);

  return (
    <Frame onClose={onClose} onRefresh={refresh}>
      <div className="launcher__k-body">
        <TierModelsBlock
          error={tierSet.error?.message ?? tierGet.error?.message ?? null}
          models={models.models}
          onChange={(next) => void tierSet.run(next).then(refresh)}
          settingsModel={settingsModel}
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
                  settingsModel={settingsModel}
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
  settingsModel,
  models,
  unreadable,
  onChanged,
}: {
  id: number;
  reload: number;
  tierModels: TierModels | null;
  settingsModel: string | null;
  models: readonly Model[];
  unreadable: boolean;
  onChanged(): void;
}): React.ReactElement {
  const detail = useOperation<LauncherContract, 'launcher.intentGet'>('launcher.intentGet');
  const withdraw = useOperation<LauncherContract, 'launcher.intentWithdraw'>('launcher.intentWithdraw');
  const setModel = useOperation<LauncherContract, 'launcher.intentTaskModel'>('launcher.intentTaskModel');
  const start = useOperation<LauncherContract, 'launcher.intentRun'>('launcher.intentRun');
  const stop = useOperation<LauncherContract, 'launcher.intentStop'>('launcher.intentStop');
  const answer = useOperation<LauncherContract, 'launcher.intentAnswer'>('launcher.intentAnswer');
  // The same approval table a chat's card answers: one question, one answer.
  const confirm = useOperation<AiContract, 'ai.chatConfirm'>('ai.chatConfirm');
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
      onAnswer={(taskId, text) => void answer.run({ taskId, answer: text, by: 'the person' }).then(onChanged)}
      onConfirm={(question, approve) =>
        void confirm.run({ runId: question.runId, callId: question.callId, approve }).then(onChanged)
      }
      onRun={() => void start.run({ id }).then(onChanged)}
      onStop={() => void stop.run({ id }).then(onChanged)}
      runError={start.error?.message ?? stop.error?.message ?? answer.error?.message ?? confirm.error?.message ?? null}
      settingsModel={settingsModel}
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
