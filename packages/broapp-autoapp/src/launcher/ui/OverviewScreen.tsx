/**
 * The Overview: the screen the launcher opens on.
 *
 * One read of `launcher.overview`, drawn as the mockup the owner approved
 * (`prompts/autoapp/mockups/overview.html`) lays it out: what needs the person,
 * the run in hand and its stage, what is left, each application, and what it
 * has cost. Its layout, placement, hierarchy and words are the mockup's; its
 * colours and type are the launcher's own `--launcher-*` variables and system
 * font, in both schemes.
 *
 * It decides nothing. Every action opens the place where that decision is
 * already made — the Backlog panel at a question or a failure, the candidate
 * panel for a release ready to activate, an application's own tab — and the
 * screen never activates, answers, stops or revises anything itself. The one
 * thing it writes is the prices a person types into its prices section.
 *
 * `App` reads the route and hands the data in, so this component can be drawn
 * from fixed values: nothing here reads the bridge but the prices section.
 */
import { useEffect, useState } from 'react';

import { useOperation } from 'broapp/react';
import type { OperationOutput } from 'broapp/shared';

import type { LauncherContract } from '../contract.ts';
import { STANDING_WORDS } from '../standing-words.ts';
import { AppIcon } from './AppIcon.tsx';
import { modelName, type ModelPlaces } from './IntentPanel.tsx';

export type OverviewData = OperationOutput<LauncherContract, 'launcher.overview'>;
export type NeedsYouItem = OverviewData['needsYou'][number];
export type NeedsYouTarget = NeedsYouItem['target'];
type Running = NonNullable<OverviewData['running']>;
type SpendTotal = OverviewData['spend']['today'];
type AppBlock = OverviewData['apps'][number];
type BacklogBlock = OverviewData['backlog'][number];

/** The stages, in the order the stepper draws them. */
export const STAGES = [
  { id: 'reading', label: 'Reading' },
  { id: 'editing', label: 'Editing' },
  { id: 'building', label: 'Building' },
  { id: 'checking', label: 'Checking' },
] as const;

/** The class the one filled button carries; a test counts it. */
export const PRIMARY = 'launcher__button--primary';

// ── Words and numbers ───────────────────────────────────────────────────────

function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, '');
}

/** Tokens as a person reads them: 870, 41k, 312k, 1.4M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${trimmed(tokens / 1_000, 1)}k`;
  if (tokens < 1_000_000) return `${String(Math.round(tokens / 1_000))}k`;
  return `${trimmed(tokens / 1_000_000, 1)}M`;
}

/** Dollars, to the cent; a cost too small to show in cents says so. */
export function formatCost(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}

/** A duration as a turn's clock shows it: 42s, 6m 10s, 1h 5m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** How long ago, in words: "38 seconds ago", "4 minutes ago". */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${count(seconds, 'second', 'seconds')} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${count(minutes, 'minute', 'minutes')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${count(hours, 'hour', 'hours')} ago`;
  return `${count(Math.floor(hours / 24), 'day', 'days')} ago`;
}

/** A limit in words: "8 minutes", "40 seconds". */
export function limitWords(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) && minutes >= 1 ? count(minutes, 'minute', 'minutes') : count(Math.round(ms / 1_000), 'second', 'seconds');
}

/** "About 35 min remaining". */
export function remainingWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `About ${String(minutes)} min remaining`;
  return `About ${trimmed(minutes / 60, 1)} h remaining`;
}

/** "7m 12s" until a moment, never below zero. */
export function countdown(until: number, now: number): string {
  return formatDuration(Math.max(0, until - now));
}

/** Under a minute of quiet left before the idle limit ends the turn. */
export function quietIsShort(running: Pick<Running, 'quietSince' | 'idleLimitMs'>, now: number): boolean {
  return running.idleLimitMs - (now - running.quietSince) < 60_000;
}

/** How the kinds of what needs the person read under its count. */
export function attentionKinds(items: readonly Pick<NeedsYouItem, 'kind'>[]): string {
  const questions = items.filter((item) => item.kind === 'question' || item.kind === 'answer').length;
  const failed = items.filter((item) => item.kind === 'advice').length;
  const ready = items.filter((item) => item.kind === 'activate').length;
  const parts: string[] = [];
  if (questions > 0) parts.push(count(questions, 'question', 'questions'));
  if (failed > 0) parts.push(count(failed, 'failed task', 'failed tasks'));
  if (ready > 0) parts.push(`${String(ready)} ready to activate`);
  return parts.join(' · ');
}

/** The action a row offers, in the mockup's words. */
function actionWords(kind: NeedsYouItem['kind']): string {
  if (kind === 'advice') return 'Review issue';
  if (kind === 'activate') return 'Review';
  return 'Answer';
}

/** The mark beside a row: a question, a failure, a release waiting. */
function markOf(kind: NeedsYouItem['kind']): { symbol: string; tone: 'warn' | 'error' | 'good' } {
  if (kind === 'advice') return { symbol: '!', tone: 'error' };
  if (kind === 'activate') return { symbol: '✓', tone: 'good' };
  return { symbol: '?', tone: 'warn' };
}

const STATE_WORDS: Readonly<Record<AppBlock['state'], string>> = {
  building: 'Building',
  serving: 'Serving',
  'needs-review': 'Needs review',
  stopped: 'Stopped',
};

/** What "≥" and "partial" mean, where a person can hover to read it. */
const FLOOR_WORDS = 'At least this much: a turn that was cut short, or one still running, has not said all it used.';

/** The tokens of a total, and whether they are only a floor. */
function tokensOf(total: SpendTotal | null): string {
  if (total === null) return 'none';
  const tokens = formatTokens(total.inputTokens + total.outputTokens);
  return total.atLeast ? `≥${tokens}` : tokens;
}

// ── The screen ──────────────────────────────────────────────────────────────

/** What the alerts control needs. */
export interface AlertsState {
  /** The browser's notification permission, or `unsupported`. */
  readonly permission: string;
  readonly sound: boolean;
  onTurnOn(): void;
  onSound(on: boolean): void;
  onTestSound(): void;
}

export interface OverviewScreenProps {
  /** The last good read, or `null` before the first one. */
  readonly overview: OverviewData | null;
  /** The last read failed; what is shown is the one before it. */
  readonly stale: boolean;
  readonly alerts: AlertsState;
  /** The moment the figures are drawn at; tests fix it. */
  readonly now?: number;
  /** Open the panel an attention row, or an application's review, names. */
  onOpenTarget(target: NeedsYouTarget): void;
  /** Open the Backlog panel, on an intent when one is given. */
  onOpenBacklog(focus: { readonly appId: string; readonly intentId: number } | null): void;
  onOpenPreview(appId: string): void;
  /** Open an application's own tab, starting it if it is not running. */
  onOpenApp(appId: string): void;
  /** The chat, with the applications column open. */
  onViewAll(): void;
  /** When the figures shown were read, for a refresh that failed. */
  readonly readAt?: number | null;
  /** What Open preview answered, when it could not open one. */
  readonly previewError?: string | null;
  /**
   * Where each provider runs and which is in use, so the running task's model
   * is named with where it runs. Absent, the model is named by its reference.
   */
  readonly places?: ModelPlaces;
}

/** The running task's model, named with where it runs, in the words every picker uses. */
export function runningModel(ref: string | null, places: ModelPlaces | undefined): string | null {
  if (ref === null) return null;
  if (places === undefined) return ref;
  return modelName(ref, [], places);
}

export function OverviewScreen(props: OverviewScreenProps): React.ReactElement {
  const { overview, stale, alerts } = props;
  const now = props.now ?? Date.now();
  const [pricesOpen, setPricesOpen] = useState(false);

  if (overview === null) {
    return (
      <main aria-label="Overview" className="launcher__overview">
        <Header alerts={alerts} />
        <p className="launcher__ov-note" role="status">
          {stale ? 'Could not refresh' : 'Reading the overview…'}
        </p>
      </main>
    );
  }

  const names = new Map(overview.apps.map((app) => [app.appId, app.name]));
  const nameOf = (appId: string): string => names.get(appId) ?? appId;
  const items = overview.needsYou;
  const running = overview.running;
  // One filled button: the first thing that needs the person, else the preview
  // of the run in hand, else the way into the backlog.
  const primary: 'attention' | 'preview' | 'backlog' = items.length > 0 ? 'attention' : running !== null ? 'preview' : 'backlog';

  return (
    <main aria-label="Overview" className="launcher__overview">
      <Header alerts={alerts} />
      {stale ? (
        <p className="launcher__ov-note launcher__ov-warn" role="status">
          Could not refresh.{props.readAt === undefined || props.readAt === null ? '' : ` Showing figures from ${ago(now - props.readAt)}.`}
        </p>
      ) : null}

      <Summary overview={overview} onPrices={() => setPricesOpen(true)} />
      {/* A setting, not something that needs the person: one muted line. */}
      {overview.standing === true ? <p className="launcher__ov-standing">{STANDING_WORDS.overviewLine}</p> : null}

      <section aria-label="Needs your attention" aria-live="polite" className={`launcher__ov-attention${items.length === 0 ? ' launcher__ov-attention--calm' : ''}`}>
        {items.length === 0 ? (
          <p className="launcher__ov-calm">Nothing needs you</p>
        ) : (
          <>
            <h2 className="launcher__ov-band-title">
              Needs your attention <span className="launcher__ov-count">{items.length}</span>
            </h2>
            <ul className="launcher__ov-items">
              {items.map((item, index) => (
                <AttentionRow
                  appName={nameOf(item.appId)}
                  filled={primary === 'attention' && index === 0}
                  item={item}
                  key={item.key}
                  now={now}
                  onOpen={() => props.onOpenTarget(item.target)}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="launcher__ov-main">
        <RunningCard
          appName={running === null ? '' : nameOf(running.appId)}
          filled={primary}
          now={now}
          onDetails={() => (running === null ? props.onOpenBacklog(null) : props.onOpenBacklog({ appId: running.appId, intentId: running.intentId }))}
          onPreview={() => (running === null ? undefined : props.onOpenPreview(running.appId))}
          model={running === null ? null : runningModel(running.modelId, props.places)}
          previewError={props.previewError ?? null}
          running={running}
        />
        <Applications
          apps={overview.apps}
          backlog={overview.backlog}
          needsYou={items}
          now={now}
          onOpenApp={props.onOpenApp}
          onOpenTarget={props.onOpenTarget}
          onViewAll={props.onViewAll}
        />
      </div>

      <footer className="launcher__ov-foot">
        <span>
          Tokens today<b className="launcher__ov-tnum">{tokensOf(overview.spend.today)}</b>
        </span>
        <span>
          Current run<b className="launcher__ov-tnum">{tokensOf(overview.spend.run)}</b>
        </span>
        <span>
          Current task<b className="launcher__ov-tnum">{tokensOf(overview.spend.task)}</b>
          {overview.spend.task?.atLeast === true ? <span title={FLOOR_WORDS}> · partial</span> : ''}
        </span>
        <span className="launcher__ov-foot-end">
          <button aria-expanded={pricesOpen} className="launcher__ov-link" onClick={() => setPricesOpen((open) => !open)} type="button">
            View usage
          </button>
        </span>
      </footer>

      {pricesOpen ? <PricesSection onClose={() => setPricesOpen(false)} usage={overview.spend.todayByModel} /> : null}
    </main>
  );
}

function Header({ alerts }: { readonly alerts: AlertsState }): React.ReactElement {
  return (
    <header className="launcher__ov-header">
      <div>
        <h1 className="launcher__ov-title">Overview</h1>
        <p className="launcher__ov-lede">Everything you need to keep work moving.</p>
      </div>
      <div aria-label="Alerts" className="launcher__ov-alerts" role="group">
        {alerts.permission === 'default' ? (
          <button className="launcher__ov-link" onClick={alerts.onTurnOn} type="button">
            Turn on alerts
          </button>
        ) : alerts.permission === 'denied' ? (
          <span className="launcher__ov-muted">Notifications are blocked in this browser’s settings. Sound still works.</span>
        ) : alerts.permission === 'unsupported' ? (
          <span className="launcher__ov-muted">This browser shows no notifications.</span>
        ) : null}
        <label className="launcher__ov-switch">
          <input checked={alerts.sound} onChange={(event) => alerts.onSound(event.currentTarget.checked)} type="checkbox" />
          Sound
        </label>
        <button className="launcher__ov-link" onClick={alerts.onTestSound} type="button">
          Test sound
        </button>
      </div>
    </header>
  );
}

function Summary({ overview, onPrices }: { readonly overview: OverviewData; readonly onPrices: () => void }): React.ReactElement {
  const items = overview.needsYou;
  const running = overview.running;
  const queued = overview.backlog.reduce((sum, block) => sum + block.queued + block.blocked, 0);
  // An estimate only when every application with queued tasks has one: a sum
  // that left one out would look like the whole and be less.
  const waiting = overview.backlog.filter((block) => block.queued + block.blocked > 0);
  const known = waiting.length > 0 && waiting.every((block) => block.estimate !== null);
  const estimateMs = known ? waiting.reduce((sum, block) => sum + (block.estimate?.ms ?? 0), 0) : null;
  return (
    <section aria-label="Summary" className="launcher__ov-card launcher__ov-summary">
      <div className={items.length > 0 ? 'launcher__ov-tile launcher__ov-tile--hot' : 'launcher__ov-tile'}>
        <div className="launcher__ov-k">Needs attention</div>
        <div className="launcher__ov-num launcher__ov-tnum">{items.length}</div>
        <div className="launcher__ov-s">{items.length === 0 ? 'Nothing needs you' : attentionKinds(items)}</div>
      </div>
      <div className="launcher__ov-tile">
        <div className="launcher__ov-k">Running now</div>
        <div className="launcher__ov-num launcher__ov-tnum">{running === null ? 0 : 1}</div>
        <div className="launcher__ov-s">{running === null ? 'Nothing is running' : running.appName}</div>
      </div>
      <div className="launcher__ov-tile">
        <div className="launcher__ov-k">Queued tasks</div>
        <div className="launcher__ov-num launcher__ov-tnum">{queued}</div>
        {estimateMs !== null ? <div className="launcher__ov-s">{remainingWords(estimateMs)}</div> : null}
      </div>
      <SpentTile onPrices={onPrices} spend={overview.spend} />
    </section>
  );
}

/** Spent today, said honestly: dollars only where there is a cost, a floor marked as one. */
export function SpentTile({ spend, onPrices }: { readonly spend: OverviewData['spend']; readonly onPrices: () => void }): React.ReactElement {
  const today = spend.today;
  const tokens = today.inputTokens + today.outputTokens;
  const budget = spend.budgetDay;
  let figure: React.ReactNode;
  const lines: React.ReactNode[] = [];
  if (tokens === 0 && !today.atLeast) {
    figure = '0';
    lines.push(<div className="launcher__ov-s" key="none">Nothing has run today</div>);
  } else if (today.cost === null) {
    figure = `${today.atLeast ? '≥' : ''}${formatTokens(tokens)} tokens`;
    lines.push(
      <div className="launcher__ov-s" key="prices">
        <button className="launcher__ov-link" onClick={onPrices} type="button">
          No prices set
        </button>
      </div>,
    );
  } else {
    figure = `${today.atLeast ? '≥' : ''}${formatCost(today.cost)}`;
    if (budget !== null && budget > 0) {
      const share = Math.round((today.cost / budget) * 100);
      lines.push(
        <div className={share >= 100 ? 'launcher__ov-s launcher__ov-warn' : 'launcher__ov-s'} key="budget">
          of {formatCost(budget)} budget <span className="launcher__ov-nowrap">· {share}%</span>
        </div>,
      );
    }
    if (today.unpricedTokens > 0) {
      lines.push(
        <div className="launcher__ov-s" key="unpriced">
          {formatTokens(today.unpricedTokens)} tokens have no price
        </div>,
      );
    }
  }
  return (
    <div className="launcher__ov-tile">
      <div className="launcher__ov-k">Spent today</div>
      <div className="launcher__ov-num launcher__ov-tnum">
        {figure}
        {today.atLeast && tokens > 0 ? (
          <span className="launcher__ov-partial" title={FLOOR_WORDS}>
            {' '}
            partial
          </span>
        ) : null}
      </div>
      {lines}
    </div>
  );
}

function AttentionRow({
  item,
  appName,
  filled,
  now,
  onOpen,
}: {
  readonly item: NeedsYouItem;
  readonly appName: string;
  readonly filled: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}): React.ReactElement {
  const mark = markOf(item.kind);
  return (
    <li className="launcher__ov-item">
      <span aria-hidden="true" className={`launcher__ov-mark launcher__ov-mark--${mark.tone}`}>
        {mark.symbol}
      </span>
      <span className="launcher__ov-item-title">{item.title}</span>
      <span className="launcher__ov-item-detail">
        {appName} · {item.expiresAt === null ? item.detail : <Countdown now={now} until={item.expiresAt} />}
      </span>
      <button className={`launcher__button${filled ? ` ${PRIMARY}` : ''}`} onClick={onOpen} type="button">
        {actionWords(item.kind)}
      </button>
    </li>
  );
}

/** "Answer within 7m 12s", ticking once a second on this row alone. Not a live region. */
function Countdown({ until, now }: { readonly until: number; readonly now: number }): React.ReactElement {
  const [at, setAt] = useState(now);
  useEffect(() => {
    setAt(Date.now());
    const timer = setInterval(() => setAt(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [until]);
  // `off`: inside the band's polite region, a clock that ticks would be read
  // out every second. The band announces when its items change, not this.
  return (
    <span aria-live="off" className="launcher__ov-nowrap">
      Answer within {countdown(until, at)}
    </span>
  );
}

function Stepper({ stage }: { readonly stage: Running['stage'] }): React.ReactElement {
  const current = STAGES.findIndex((step) => step.id === stage);
  return (
    <ol aria-label="Stage" className="launcher__ov-steps">
      {STAGES.map((step, index) => (
        <li
          aria-current={index === current ? 'step' : undefined}
          className={index < current ? 'launcher__ov-step launcher__ov-step--done' : index === current ? 'launcher__ov-step launcher__ov-step--on' : 'launcher__ov-step'}
          key={step.id}
        >
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function RunningCard({
  running,
  appName,
  model,
  now,
  filled,
  onPreview,
  onDetails,
  previewError,
}: {
  readonly running: Running | null;
  readonly appName: string;
  /** The model the task is on, with where it runs; `null` when not known. */
  readonly model: string | null;
  readonly now: number;
  readonly filled: 'attention' | 'preview' | 'backlog';
  readonly onPreview: () => void;
  readonly onDetails: () => void;
  readonly previewError: string | null;
}): React.ReactElement {
  if (running === null) {
    return (
      <section aria-label="Running now" className="launcher__ov-card launcher__ov-pad launcher__ov-now">
        <div className="launcher__ov-between">
          <span className="launcher__ov-eyebrow">Running now</span>
        </div>
        <h2 className="launcher__ov-now-title">Nothing is running</h2>
        <p className="launcher__ov-where">A backlog runs here once you start it from the Backlog panel.</p>
        <div className="launcher__ov-actions">
          <button className={`launcher__button${filled === 'backlog' ? ` ${PRIMARY}` : ''}`} onClick={onDetails} type="button">
            Open backlog
          </button>
        </div>
      </section>
    );
  }
  const stageLabel = STAGES.find((step) => step.id === running.stage)?.label ?? running.stage;
  const short = quietIsShort(running, now);
  return (
    <section aria-label="Running now" className="launcher__ov-card launcher__ov-pad launcher__ov-now">
      <div className="launcher__ov-between">
        <span className="launcher__ov-eyebrow">Running now</span>
        <span className="launcher__ov-state">
          <span aria-hidden="true" className="launcher__ov-dot launcher__ov-dot--good" />
          {stageLabel}
        </span>
      </div>
      <h2 className="launcher__ov-now-title">{running.taskTitle}</h2>
      <p className="launcher__ov-where">
        {appName} · Task {running.taskIndex} of {running.taskCount}
        {model === null ? null : ` · ${model}`}
      </p>
      <Stepper stage={running.stage} />
      <div className="launcher__ov-facts">
        <div>
          <div className="launcher__ov-fact launcher__ov-tnum">{running.filesChanged}</div>
          <div className="launcher__ov-k">Files changed</div>
        </div>
        <div>
          <div className="launcher__ov-fact launcher__ov-tnum">
            {running.criteria.passed} / {running.criteria.total}
          </div>
          <div className="launcher__ov-k">Checks passing</div>
        </div>
        <div>
          <div className="launcher__ov-fact launcher__ov-tnum">{formatDuration(now - running.startedAt)}</div>
          <div className="launcher__ov-k">Turn time</div>
        </div>
      </div>
      <p className={short ? 'launcher__ov-quiet launcher__ov-warn' : 'launcher__ov-quiet'}>
        Last activity {ago(now - running.quietSince)} · attempt {running.turn} of {running.maxAttempts} · stops if quiet for{' '}
        {limitWords(running.idleLimitMs)}
      </p>
      {running.lastRefusal === null ? null : (
        <p className="launcher__ov-quiet">
          Last refused: <code>{running.lastRefusal.tool}</code> {running.lastRefusal.reason}
        </p>
      )}
      {previewError === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {previewError}
        </p>
      )}
      <div className="launcher__ov-actions">
        <button className={`launcher__button${filled === 'preview' ? ` ${PRIMARY}` : ''}`} onClick={onPreview} type="button">
          Open preview
        </button>
        <button className="launcher__button" onClick={onDetails} type="button">
          View details
        </button>
        {/* Stopping is the Backlog panel's, with its own confirmation. */}
        <button
          className="launcher__ov-link launcher__ov-link--end"
          onClick={onDetails}
          title="Opens the Backlog panel, where the run is stopped after you confirm."
          type="button"
        >
          Stop run
        </button>
      </div>
    </section>
  );
}

/** What an application row offers, by its state. */
export function appAction(app: Pick<AppBlock, 'state'>): 'Open' | 'Review' | 'Start' {
  if (app.state === 'needs-review') return 'Review';
  if (app.state === 'stopped') return 'Start';
  return 'Open';
}

function Applications({
  apps,
  backlog,
  needsYou,
  now,
  onOpenApp,
  onOpenTarget,
  onViewAll,
}: {
  readonly apps: readonly AppBlock[];
  readonly backlog: readonly BacklogBlock[];
  readonly needsYou: readonly NeedsYouItem[];
  readonly now: number;
  onOpenApp(appId: string): void;
  onOpenTarget(target: NeedsYouTarget): void;
  onViewAll(): void;
}): React.ReactElement {
  const work = new Map(backlog.map((block) => [block.appId, block]));
  return (
    <section aria-label="Applications" className="launcher__ov-card launcher__ov-pad launcher__ov-apps">
      <div className="launcher__ov-between">
        <h2 className="launcher__ov-apps-title">Applications</h2>
        <button className="launcher__ov-link launcher__ov-link--plain" onClick={onViewAll} type="button">
          View all
        </button>
      </div>
      {apps.length === 0 ? (
        <p className="launcher__ov-where launcher__ov-empty">No applications yet. Create one from the chat or the applications column.</p>
      ) : null}
      <ul className="launcher__ov-app-list" hidden={apps.length === 0}>
        {apps.map((app) => {
          const block = work.get(app.appId);
          const action = appAction(app);
          const review = needsYou.find((item) => item.appId === app.appId);
          const share = block === undefined || block.total === 0 ? null : Math.round((block.done / block.total) * 100);
          return (
            <li className="launcher__ov-app" key={app.appId}>
              <div className="launcher__ov-app-who">
                <AppIcon appId={app.appId} name={app.name} />
                <div>
                  <div className="launcher__ov-app-name">{app.name}</div>
                  <div className="launcher__ov-app-detail">
                    {block === undefined
                      ? app.changedAt === null
                        ? 'Not built yet'
                        : `Last changed ${ago(now - app.changedAt)}`
                      : `${String(block.done)} of ${count(block.total, 'task', 'tasks')} done`}
                  </div>
                </div>
              </div>
              <span className="launcher__ov-state">
                <span aria-hidden="true" className={`launcher__ov-dot launcher__ov-dot--${app.state}`} />
                {STATE_WORDS[app.state]}
              </span>
              <button
                className="launcher__button"
                onClick={() => (action === 'Review' && review !== undefined ? onOpenTarget(review.target) : onOpenApp(app.appId))}
                type="button"
              >
                {action}
              </button>
              {share === null ? null : (
                <div className="launcher__ov-meter">
                  <span aria-label={`${String(share)}% of tasks done`} className="launcher__ov-track" role="img">
                    <span className="launcher__ov-fill" style={{ width: `${String(share)}%` }} />
                  </span>
                  <span className="launcher__ov-tnum">{share}%</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Prices ──────────────────────────────────────────────────────────────────

interface PriceRow {
  readonly modelId: string;
  input: string;
  output: string;
}

/**
 * Today's usage by model, and what each model costs, as the person says.
 *
 * Plain fields; the route checks the numbers and says what is wrong.
 */
function PricesSection({ usage, onClose }: { readonly usage: OverviewData['spend']['todayByModel']; readonly onClose: () => void }): React.ReactElement {
  const get = useOperation<LauncherContract, 'launcher.pricesGet'>('launcher.pricesGet');
  const set = useOperation<LauncherContract, 'launcher.pricesSet'>('launcher.pricesSet');
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [budget, setBudget] = useState('');
  const { run: load } = get;
  useEffect(() => void load(undefined), [load]);
  const loaded = get.data;
  useEffect(() => {
    if (loaded === null || rows !== null) return;
    const priced = new Map(loaded.models.map((model) => [model.modelId, model]));
    const ids = [...new Set([...usage.flatMap((part) => (part.modelId === null ? [] : [part.modelId])), ...priced.keys()])];
    setRows(ids.map((modelId) => ({ modelId, input: String(priced.get(modelId)?.input ?? ''), output: String(priced.get(modelId)?.output ?? '') })));
    setBudget(loaded.budgetDay === null ? '' : String(loaded.budgetDay));
  }, [loaded, rows, usage]);

  const save = (): void => {
    const models = (rows ?? [])
      .filter((row) => row.input.trim() !== '' || row.output.trim() !== '')
      .map((row) => ({ modelId: row.modelId, input: Number(row.input), output: Number(row.output) }));
    void set.run({ models, budgetDay: budget.trim() === '' ? null : Number(budget) });
  };
  const edit = (modelId: string, side: 'input' | 'output', value: string): void =>
    setRows((current) => (current ?? []).map((row) => (row.modelId === modelId ? { ...row, [side]: value } : row)));

  return (
    <section aria-label="Usage and prices" className="launcher__ov-card launcher__ov-pad launcher__ov-prices">
      <div className="launcher__ov-between">
        <h2 className="launcher__card-title">Usage today, and prices</h2>
        <button className="launcher__button launcher__button--small" onClick={onClose} type="button">
          Close
        </button>
      </div>
      <p className="launcher__lede">
        Prices are yours to set, in dollars per million tokens. A model with no price shows its tokens and no cost; the budget is shown, never
        enforced.
      </p>
      {usage.length === 0 ? <p className="launcher__ov-where">Nothing has run today.</p> : null}
      {usage.length > 0 ? (
        <table className="launcher__table launcher__ov-usage">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.map((part) => (
              <tr key={part.modelId ?? 'unknown'}>
                <td>{part.modelId ?? 'unknown model'}</td>
                <td className="launcher__ov-tnum">
                  {part.atLeast ? '≥' : ''}
                  {formatTokens(part.inputTokens + part.outputTokens)}
                </td>
                <td className="launcher__ov-tnum">{part.cost === null ? 'no price' : `${part.atLeast ? '≥' : ''}${formatCost(part.cost)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form
        className="launcher__form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {(rows ?? []).map((row) => (
          <fieldset className="launcher__ov-price" key={row.modelId}>
            <legend>{row.modelId}</legend>
            <label className="launcher__field">
              Input, $ per million
              <input className="launcher__input" inputMode="decimal" min="0" onChange={(event) => edit(row.modelId, 'input', event.currentTarget.value)} step="any" type="number" value={row.input} />
            </label>
            <label className="launcher__field">
              Output, $ per million
              <input className="launcher__input" inputMode="decimal" min="0" onChange={(event) => edit(row.modelId, 'output', event.currentTarget.value)} step="any" type="number" value={row.output} />
            </label>
          </fieldset>
        ))}
        <label className="launcher__field">
          Daily budget, $
          <input className="launcher__input" inputMode="decimal" min="0" onChange={(event) => setBudget(event.currentTarget.value)} step="any" type="number" value={budget} />
        </label>
        {set.error === null ? null : (
          <p className="launcher__message launcher__message--error" role="alert">
            {set.error.message}
          </p>
        )}
        {get.error === null ? null : (
          <p className="launcher__message launcher__message--error" role="alert">
            {get.error.message}
          </p>
        )}
        {set.data !== null && set.error === null && !set.pending ? <p className="launcher__ov-muted">Saved.</p> : null}
        <div className="launcher__ov-actions">
          <button className="launcher__button" disabled={set.pending || rows === null} type="submit">
            Save prices
          </button>
        </div>
      </form>
    </section>
  );
}
