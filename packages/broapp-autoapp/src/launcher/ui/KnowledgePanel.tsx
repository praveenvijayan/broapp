/**
 * A window on the knowledge layer: the turns, the lessons, the cases.
 *
 * Everything here is read through the launcher's own routes from the store the
 * learning loop already keeps, and the only writes are the four a person may
 * make to a lesson — confirm, retire, write, replace — which go through the
 * same functions `knowledge confirm` and `knowledge retire` use. A lesson's
 * text is never edited: a correction is a new lesson that supersedes the old
 * one, so every serving keeps pointing at what was actually served.
 *
 * It refreshes when it opens and when Refresh is pressed, never on a timer. A
 * person reading a lesson's provenance should not have the list move under
 * them; the log is the panel that follows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOperation } from 'broapp/react';

import type { LauncherContract } from '../contract.ts';

type Tab = 'turns' | 'lessons' | 'cases';

/** Where the open tab and the reviewer's name are remembered. */
export const KNOWLEDGE_TAB = 'broapp-autoapp:knowledge-tab';
export const KNOWLEDGE_BY = 'broapp-autoapp:knowledge-by';

/** The stages a lesson may name, in the order a build runs them. */
const STAGES = ['spec', 'contract', 'views', 'page', 'host', 'check'] as const;

/** A lesson's limits, as `review.ts` holds them. */
const SUMMARY_MAX = 300;
const DETAIL_MAX = 2_000;
const TRIGGER_MAX = 300;

/** How many turns and cases one read asks for. */
const ROWS = 100;

/** The sentence every retire and replace says before it happens. */
export const STOPS_BEING_SERVED = 'This lesson stops being served; its servings and case stay.';

function recall(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The panel still works; it forgets.
  }
}

/** `12 Sep 13:04`, local time. */
function when(at: number): string {
  const date = new Date(at);
  const month = date.toLocaleString('en', { month: 'short' });
  const time = [date.getHours(), date.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${String(date.getDate())} ${month} ${time}`;
}

/** At most `max` characters, marked when cut. */
function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Which of the four colour pairs an outcome or a status is drawn in. */
function tone(word: string): 'good' | 'warn' | 'error' | 'quiet' {
  if (word === 'resolved' || word === 'confirmed') return 'good';
  if (word === 'recurred' || word === 'retired') return 'error';
  if (word === 'blocked' || word === 'provisional' || word.startsWith('needs_review')) return 'warn';
  return 'quiet';
}

function Chip({ word, dim, title }: { word: string; dim?: boolean; title?: string }): React.ReactElement {
  return (
    <span
      className={`launcher__k-chip launcher__k-chip--${tone(word)}${dim === true ? ' launcher__k-chip--dim' : ''}`}
      title={title}
    >
      {word}
    </span>
  );
}

export interface KnowledgePanelProps {
  /** Applications, for a lesson's scope. */
  readonly apps: readonly string[];
  onClose(): void;
  /**
   * Draw only the frame and this sentence. The tab passes nothing; a test
   * passes the refusal a launcher without a store gives, to see it said.
   */
  readonly error?: string;
}

/** The panel's frame: heading, close, and whatever is inside. */
function Frame({ onClose, children }: { onClose(): void; children: React.ReactNode }): React.ReactElement {
  return (
    <aside aria-label="Knowledge" className="launcher__logs launcher__k">
      <div className="launcher__settings-header">
        <h2 className="launcher__card-title">Knowledge</h2>
        <button className="launcher__button launcher__button--small" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {children}
    </aside>
  );
}

export function KnowledgePanel({ apps, onClose, error }: KnowledgePanelProps): React.ReactElement {
  if (error !== undefined) {
    return (
      <Frame onClose={onClose}>
        <p className="launcher__message launcher__message--error" role="alert">
          {error}
        </p>
      </Frame>
    );
  }
  return <LiveKnowledgePanel apps={apps} onClose={onClose} />;
}

function LiveKnowledgePanel({ apps, onClose }: { apps: readonly string[]; onClose(): void }): React.ReactElement {
  const [tab, setTab] = useState<Tab>(() => {
    const stored = recall(KNOWLEDGE_TAB, 'turns');
    return stored === 'lessons' || stored === 'cases' ? stored : 'turns';
  });
  const [by, setBy] = useState(() => recall(KNOWLEDGE_BY, 'tab'));
  const [reload, setReload] = useState(0);
  const [focusLesson, setFocusLesson] = useState<number | null>(null);

  const choose = useCallback((next: Tab): void => {
    setTab(next);
    keep(KNOWLEDGE_TAB, next);
  }, []);

  const openLesson = useCallback(
    (id: number): void => {
      setFocusLesson(id);
      choose('lessons');
    },
    [choose],
  );

  const tabs: readonly [Tab, string][] = [
    ['turns', 'Turns'],
    ['lessons', 'Lessons'],
    ['cases', 'Cases'],
  ];

  return (
    <Frame onClose={onClose}>
      <div className="launcher__log-controls">
        <div aria-label="Knowledge views" className="launcher__k-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              aria-selected={tab === id}
              className={`launcher__k-tab${tab === id ? ' launcher__k-tab--active' : ''}`}
              key={id}
              onClick={() => choose(id)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <label className="launcher__log-control">
          Reviewing as
          <input
            className="launcher__input"
            maxLength={80}
            onChange={(event) => {
              setBy(event.target.value);
              keep(KNOWLEDGE_BY, event.target.value);
            }}
            type="text"
            value={by}
          />
        </label>
        <button className="launcher__button launcher__button--small" onClick={() => setReload((n) => n + 1)} type="button">
          Refresh
        </button>
      </div>

      <div className="launcher__k-body" role="tabpanel">
        {tab === 'turns' ? <TurnsView onOpenLesson={openLesson} reload={reload} /> : null}
        {tab === 'lessons' ? (
          <LessonsView
            apps={apps}
            by={by.trim() === '' ? 'tab' : by.trim()}
            focus={focusLesson}
            onChanged={() => setReload((n) => n + 1)}
            reload={reload}
          />
        ) : null}
        {tab === 'cases' ? <CasesView onOpenLesson={openLesson} reload={reload} /> : null}
      </div>
    </Frame>
  );
}

// ── Turns ────────────────────────────────────────────────────────────────────

/** The chip a delivered document is shown as. */
function documentChip(ref: string, lessons: number): string {
  if (ref.startsWith('digest:')) return 'orientation';
  if (ref.startsWith('evidence:')) return 'evidence';
  if (ref.startsWith('lessons:')) return `lessons ×${String(lessons)}`;
  return ref;
}

function TurnsView({ reload, onOpenLesson }: { reload: number; onOpenLesson(id: number): void }): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.knowledgeTurns'>('launcher.knowledgeTurns');
  const { run } = list;
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    void run({ limit: ROWS });
  }, [run, reload]);

  const turns = list.data?.turns ?? [];
  return (
    <>
      {list.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {list.error.message}
        </p>
      ) : null}
      {list.pending && list.data === null ? <p className="launcher__lede">Reading the turns…</p> : null}
      {list.data !== null && turns.length === 0 ? (
        <p className="launcher__lede">No turns yet. A turn is written down when the engineer is asked something.</p>
      ) : null}
      <ol className="launcher__log-list launcher__k-list">
        {turns.map((turn) => {
          const open = opened === turn.runId;
          const lessons = turn.servings.filter((serving) => serving.how === 'turn').length;
          const request = turn.request ?? (turn.words.length === 0 ? '(no request recorded)' : `words: ${turn.words.join(' ')}`);
          return (
            <li className="launcher__log-row" key={turn.runId}>
              <button
                aria-expanded={open}
                className="launcher__k-line"
                onClick={() => setOpened(open ? null : turn.runId)}
                type="button"
              >
                <span className="launcher__log-time">{when(turn.at)}</span>
                <span className="launcher__log-where">{turn.appId ?? '-'}</span>
                <span className="launcher__k-text">{head(request, 80)}</span>
                <span className="launcher__k-chips">
                  {turn.documents.map((document) => (
                    <Chip
                      dim={document.truncated}
                      key={document.ref}
                      title={document.truncated ? `${document.title}: cut by the budget` : document.title}
                      word={documentChip(document.ref, lessons)}
                    />
                  ))}
                  <span className="launcher__k-counts" title="edits / builds / checks / cases opened">
                    {turn.counts.edits}/{turn.counts.builds}/{turn.counts.checks}/{turn.counts.casesOpened}
                  </span>
                  {turn.servings.map((serving, index) => (
                    <Chip
                      dim={!serving.included}
                      key={`${String(serving.lessonId)}-${serving.how}-${String(index)}`}
                      title={`lesson ${String(serving.lessonId)} (${serving.how})`}
                      word={serving.outcome}
                    />
                  ))}
                </span>
              </button>
              {open ? <TurnDetail onOpenLesson={onOpenLesson} runId={turn.runId} /> : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function TurnDetail({ runId, onOpenLesson }: { runId: string; onOpenLesson(id: number): void }): React.ReactElement {
  const detail = useOperation<LauncherContract, 'launcher.knowledgeTurn'>('launcher.knowledgeTurn');
  const { run } = detail;
  useEffect(() => {
    void run({ runId });
  }, [run, runId]);

  if (detail.error !== null) {
    return (
      <p className="launcher__message launcher__message--error" role="alert">
        {detail.error.message}
      </p>
    );
  }
  const turn = detail.data?.turn;
  if (turn === undefined) return <p className="launcher__lede">Reading the turn…</p>;
  return (
    <div className="launcher__k-detail">
      <p className="launcher__lede">
        Run <code>{turn.runId}</code>, corpus version {turn.corpusVersion}
        {turn.run === null
          ? ''
          : ` · ${turn.run.status}, ${String(turn.run.steps)} recorded step(s)${turn.run.ms === null ? '' : `, ${String(Math.round(turn.run.ms / 1000))} s`}`}
        {' · '}instructions <code>{turn.instructions.sha256.slice(0, 12)}</code> ({turn.instructions.length} characters),
        system prompt {turn.systemLength} characters · cases resolved {turn.counts.casesResolved}
      </p>
      {turn.request !== null ? <p className="launcher__k-quote">{turn.request}</p> : null}
      {turn.documents.length === 0 ? <p className="launcher__empty">This turn was given no documents.</p> : null}
      {turn.documents.map((document) => {
        const text = turn.texts.find((entry) => entry.ref === document.ref);
        return (
          <section className="launcher__k-document" key={document.ref}>
            <h3 className="launcher__k-heading">
              {document.title} <span className="launcher__log-where">· {document.bytes} bytes</span>
              {document.truncated ? <Chip title="the AI layer's budget cut this document" word="truncated" /> : null}
            </h3>
            <pre className="launcher__log-data">
              {text?.text ?? ''}
              {text?.cut === true ? '\n… (shown up to 20,000 characters)' : ''}
            </pre>
          </section>
        );
      })}
      {turn.servings.length > 0 ? (
        <ul className="launcher__list">
          {turn.servings.map((serving, index) => (
            <li key={`${String(serving.lessonId)}-${String(index)}`}>
              <button className="launcher__k-link" onClick={() => onOpenLesson(serving.lessonId)} type="button">
                lesson {serving.lessonId}
              </button>{' '}
              as a {serving.how}: <Chip dim={!serving.included} word={serving.outcome} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Lessons ──────────────────────────────────────────────────────────────────

type StatusFilter = 'active' | 'all' | 'provisional' | 'confirmed' | 'superseded' | 'retired';

/** What the write form starts from. */
interface Draft {
  readonly summary: string;
  readonly detail: string;
  readonly trigger: string;
  readonly scope: string;
  readonly stage: string;
  readonly routes: string;
  readonly files: string;
  readonly supersedes?: number;
}

const EMPTY_DRAFT: Draft = { summary: '', detail: '', trigger: '', scope: 'global', stage: '', routes: '', files: '' };

/** A lesson's `applies`, as the three form fields. */
function appliesFields(applies: unknown): Pick<Draft, 'stage' | 'routes' | 'files'> {
  const value = typeof applies === 'object' && applies !== null ? (applies as Record<string, unknown>) : {};
  const joined = (name: string): string =>
    Array.isArray(value[name]) ? (value[name] as unknown[]).filter((item) => typeof item === 'string').join(', ') : '';
  return { stage: typeof value['stage'] === 'string' ? value['stage'] : '', routes: joined('routes'), files: joined('files') };
}

function LessonsView({
  apps,
  by,
  focus,
  reload,
  onChanged,
}: {
  apps: readonly string[];
  by: string;
  focus: number | null;
  reload: number;
  onChanged(): void;
}): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.knowledgeLessons'>('launcher.knowledgeLessons');
  const { run } = list;
  const [status, setStatus] = useState<StatusFilter>('active');
  const [review, setReview] = useState(false);
  const [opened, setOpened] = useState<number | null>(focus);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    const specific = status !== 'active' && status !== 'all';
    void run({ ...(specific ? { status } : {}), ...(review ? { review: true } : {}) });
  }, [run, status, review, reload]);

  useEffect(() => {
    if (focus !== null) setOpened(focus);
  }, [focus]);

  const focused = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest' });
  }, [opened, list.data]);

  const lessons = (list.data?.lessons ?? []).filter(
    (lesson) => status !== 'active' || lesson.status === 'provisional' || lesson.status === 'confirmed',
  );

  return (
    <>
      <div className="launcher__log-controls">
        <label className="launcher__log-control">
          Status
          <select className="launcher__input" onChange={(event) => setStatus(event.target.value as StatusFilter)} value={status}>
            <option value="active">Provisional and confirmed</option>
            <option value="provisional">Provisional</option>
            <option value="confirmed">Confirmed</option>
            <option value="superseded">Superseded</option>
            <option value="retired">Retired</option>
            <option value="all">Every lesson</option>
          </select>
        </label>
        <label className="launcher__log-follow">
          <input checked={review} onChange={(event) => setReview(event.target.checked)} type="checkbox" />
          Needs review
        </label>
        <button className="launcher__button launcher__button--small" onClick={() => setDraft(EMPTY_DRAFT)} type="button">
          Write a lesson
        </button>
      </div>

      {draft !== null ? (
        <LessonForm
          apps={apps}
          by={by}
          draft={draft}
          onCancel={() => setDraft(null)}
          onDone={(id) => {
            setDraft(null);
            setOpened(id);
            onChanged();
          }}
        />
      ) : null}

      {list.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {list.error.message}
        </p>
      ) : null}
      {list.data !== null && lessons.length === 0 ? (
        <p className="launcher__lede">No lessons match. Widen the status, or clear Needs review.</p>
      ) : null}

      <ol className="launcher__log-list launcher__k-list">
        {lessons.map((lesson) => {
          const open = opened === lesson.id;
          const other = lesson.served.blocked + lesson.served.inconclusive + lesson.served.unrelated + lesson.served.none;
          return (
            <li className="launcher__log-row" key={lesson.id} ref={open ? focused : undefined}>
              <button
                aria-expanded={open}
                className="launcher__k-line"
                onClick={() => setOpened(open ? null : lesson.id)}
                type="button"
              >
                <span className="launcher__log-time">#{lesson.id}</span>
                <span className="launcher__k-chips">
                  <Chip word={lesson.status} />
                  {lesson.review === null ? null : <Chip word={lesson.review.replace(/^needs_review:/, 'review: ')} />}
                  {lesson.diagnosis === 'method_unclear' ? <Chip title="never served" word="method unclear" /> : null}
                </span>
                <span className="launcher__log-where">
                  {lesson.origin} · {lesson.scope}
                </span>
                <span className="launcher__k-text">{head(lesson.summary, 140)}</span>
                <span className="launcher__k-counts" title="resolved / recurred / other">
                  {lesson.served.resolved}/{lesson.served.recurred}/{other}
                </span>
              </button>
              {open ? (
                <LessonDetail
                  by={by}
                  id={lesson.id}
                  onChanged={onChanged}
                  onReplace={(record) =>
                    setDraft({
                      summary: record.summary,
                      detail: record.detail,
                      trigger: record.trigger,
                      scope: record.scope,
                      ...appliesFields(record.applies),
                      supersedes: record.id,
                    })
                  }
                  reload={reload}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

interface ReplaceSource {
  readonly id: number;
  readonly summary: string;
  readonly detail: string;
  readonly trigger: string;
  readonly scope: string;
  readonly applies?: unknown;
}

function LessonDetail({
  id,
  by,
  reload,
  onChanged,
  onReplace,
}: {
  id: number;
  by: string;
  reload: number;
  onChanged(): void;
  onReplace(record: ReplaceSource): void;
}): React.ReactElement {
  const detail = useOperation<LauncherContract, 'launcher.knowledgeLesson'>('launcher.knowledgeLesson');
  const review = useOperation<LauncherContract, 'launcher.lessonReview'>('launcher.lessonReview');
  const { run } = detail;
  const [asking, setAsking] = useState<'retire' | null>(null);
  useEffect(() => {
    void run({ id });
  }, [run, id, reload]);

  const decide = async (decision: 'confirm' | 'retire'): Promise<void> => {
    setAsking(null);
    await review.run({ id, decision, by });
    onChanged();
  };

  if (detail.error !== null) {
    return (
      <p className="launcher__message launcher__message--error" role="alert">
        {detail.error.message}
      </p>
    );
  }
  const data = detail.data;
  if (data === null) return <p className="launcher__lede">Reading the lesson…</p>;
  const { lesson } = data;
  const served = lesson.status === 'provisional' || lesson.status === 'confirmed';
  const confirmable = lesson.status === 'provisional' || (lesson.status === 'confirmed' && lesson.review !== null);
  const from = lesson.provenance;

  return (
    <div className="launcher__k-detail">
      <p className="launcher__k-quote">{lesson.summary}</p>
      <dl className="launcher__k-fields">
        <dt>Detail</dt>
        <dd>{lesson.detail}</dd>
        <dt>Trigger</dt>
        <dd>{lesson.trigger}</dd>
        <dt>Applies</dt>
        <dd>
          <code>{JSON.stringify(lesson.applies)}</code>
        </dd>
        <dt>Written</dt>
        <dd>
          {when(lesson.createdAt)}, {lesson.origin}
          {lesson.diagnosis === null ? '' : ` (${lesson.diagnosis})`}, launcher {lesson.autoappVersion}
        </dd>
        {lesson.reviewedAt === null ? null : (
          <>
            <dt>Reviewed</dt>
            <dd>
              by {lesson.reviewedBy ?? 'unknown'}, {when(lesson.reviewedAt)}
            </dd>
          </>
        )}
        {lesson.supersedes === null ? null : (
          <>
            <dt>Supersedes</dt>
            <dd>lesson {lesson.supersedes}</dd>
          </>
        )}
        {lesson.supersededBy === null ? null : (
          <>
            <dt>Superseded by</dt>
            <dd>lesson {lesson.supersededBy}</dd>
          </>
        )}
      </dl>

      {from === null ? (
        <p className="launcher__lede">Written by a person; no case behind it.</p>
      ) : (
        <section className="launcher__k-document">
          <h3 className="launcher__k-heading">
            From case {from.episodeId} in {from.appId}, {from.stage}
          </h3>
          <pre className="launcher__log-data">{from.problem}</pre>
          <dl className="launcher__k-fields">
            <dt>Request</dt>
            <dd>{from.request ?? '(not recorded)'}</dd>
            <dt>Revisions</dt>
            <dd>
              <code>{from.sourceRevBefore}</code> → <code>{from.sourceRevAfter ?? 'unknown'}</code>
            </dd>
            <dt>Releases</dt>
            <dd>
              <code>{from.releaseBefore ?? 'none'}</code> → <code>{from.releaseAfter ?? 'none'}</code>
            </dd>
            <dt>Diagnosis</dt>
            <dd>
              {from.diagnosis ?? 'none'}
              {from.reasoning === null ? '' : ` — ${from.reasoning}`}
            </dd>
          </dl>
        </section>
      )}

      <h3 className="launcher__k-heading">
        Servings ({lesson.servings.length}) · blocked {data.blocked} · resolved credit unrelated by stage {data.unrelatedByStage}
      </h3>
      {lesson.servings.length === 0 ? (
        <p className="launcher__empty">Never served.</p>
      ) : (
        <div className="launcher__k-scroll">
          <table className="launcher__table launcher__k-table">
            <thead>
              <tr>
                <th>Served</th>
                <th>How</th>
                <th>Run</th>
                <th>Outcome</th>
                <th>Attempt</th>
              </tr>
            </thead>
            <tbody>
              {lesson.servings.map((serving, index) => (
                <tr key={`${serving.runId}-${String(index)}`}>
                  <td>{when(serving.servedAt)}</td>
                  <td>{serving.how}</td>
                  <td>
                    <code>{head(serving.runId, 18)}</code>
                  </td>
                  <td>
                    <Chip dim={!serving.included} word={serving.included ? (serving.outcome ?? 'open') : 'not included'} />
                  </td>
                  <td>{serving.attemptKind === null ? '-' : `${serving.attemptKind}${serving.attemptRelease === null ? '' : ` → ${serving.attemptRelease.slice(0, 8)}`}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.evidence.length === 0 ? (
        <p className="launcher__lede">No replay has been run for this lesson.</p>
      ) : (
        <pre className="launcher__log-data">{data.evidence.join('\n')}</pre>
      )}

      {review.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {review.error.message}
        </p>
      ) : null}

      {asking === 'retire' ? (
        <div className="launcher__form">
          <p className="launcher__lede">{STOPS_BEING_SERVED}</p>
          <div className="launcher__row-actions">
            <button className="launcher__button launcher__button--danger" onClick={() => void decide('retire')} type="button">
              Retire lesson {lesson.id}
            </button>
            <button className="launcher__button" onClick={() => setAsking(null)} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="launcher__row-actions">
          {confirmable ? (
            <button className="launcher__button" disabled={review.pending} onClick={() => void decide('confirm')} type="button">
              {lesson.status === 'confirmed' ? 'Confirm again' : 'Confirm'}
            </button>
          ) : null}
          {served || lesson.diagnosis === 'method_unclear' ? (
            <button
              className="launcher__button launcher__button--danger"
              disabled={review.pending || !served}
              onClick={() => setAsking('retire')}
              type="button"
            >
              Retire
            </button>
          ) : null}
          {served ? (
            <button className="launcher__button" onClick={() => onReplace(lesson)} type="button">
              Replace
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Comma-separated, as a list; empty entries dropped. */
function listOf(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function LessonForm({
  apps,
  by,
  draft,
  onCancel,
  onDone,
}: {
  apps: readonly string[];
  by: string;
  draft: Draft;
  onCancel(): void;
  onDone(id: number): void;
}): React.ReactElement {
  const write = useOperation<LauncherContract, 'launcher.lessonWrite'>('launcher.lessonWrite');
  const [fields, setFields] = useState<Draft>(draft);
  const [asking, setAsking] = useState(false);
  const replacing = draft.supersedes;
  const first = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setFields(draft);
    setAsking(false);
    first.current?.focus();
  }, [draft]);

  // `onDone` is a fresh function on every render of the list, so it is read
  // through a ref: the new id is the event, not a change of callback.
  const done = useRef(onDone);
  done.current = onDone;
  const written = write.data?.id;
  useEffect(() => {
    if (written !== undefined) done.current(written);
  }, [written]);

  const set = (name: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void =>
    setFields((current) => ({ ...current, [name]: event.target.value }));

  const submit = (): void => {
    setAsking(false);
    const routes = listOf(fields.routes);
    const files = listOf(fields.files);
    void write.run({
      summary: fields.summary,
      detail: fields.detail,
      trigger: fields.trigger,
      scope: fields.scope,
      ...(fields.stage === '' ? {} : { stage: fields.stage }),
      ...(routes.length === 0 ? {} : { routes }),
      ...(files.length === 0 ? {} : { files }),
      ...(replacing === undefined ? {} : { supersedes: replacing }),
      by,
    });
  };

  return (
    <form
      aria-label={replacing === undefined ? 'Write a lesson' : `Replace lesson ${String(replacing)}`}
      className="launcher__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (replacing === undefined) submit();
        else setAsking(true);
      }}
    >
      <h3 className="launcher__k-heading">
        {replacing === undefined ? 'Write a lesson' : `Replace lesson ${String(replacing)} with a corrected one`}
      </h3>
      <label className="launcher__field">
        <span>Summary · the fact, stated once ({fields.summary.length}/{SUMMARY_MAX})</span>
        <textarea className="launcher__input" maxLength={SUMMARY_MAX} onChange={set('summary')} ref={first} required rows={2} value={fields.summary} />
      </label>
      <label className="launcher__field">
        <span>Detail · where it was found ({fields.detail.length}/{DETAIL_MAX})</span>
        <textarea className="launcher__input" maxLength={DETAIL_MAX} onChange={set('detail')} required rows={3} value={fields.detail} />
      </label>
      <label className="launcher__field">
        <span>Trigger · the words a request would contain</span>
        <input className="launcher__input" maxLength={TRIGGER_MAX} onChange={set('trigger')} required type="text" value={fields.trigger} />
      </label>
      <div className="launcher__log-controls">
        <label className="launcher__log-control">
          Scope
          <select className="launcher__input" onChange={set('scope')} value={fields.scope}>
            <option value="global">Every application</option>
            {apps.map((appId) => (
              <option key={appId} value={`app:${appId}`}>
                {appId}
              </option>
            ))}
            {fields.scope !== 'global' && !apps.includes(fields.scope.slice(4)) ? (
              <option value={fields.scope}>{fields.scope}</option>
            ) : null}
          </select>
        </label>
        <label className="launcher__log-control">
          Stage
          <select className="launcher__input" onChange={set('stage')} value={fields.stage}>
            <option value="">Any</option>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>
        </label>
        <label className="launcher__log-control launcher__log-control--grow">
          Routes
          <input className="launcher__input" onChange={set('routes')} placeholder="items.list, items.add" type="text" value={fields.routes} />
        </label>
        <label className="launcher__log-control launcher__log-control--grow">
          Files
          <input className="launcher__input" onChange={set('files')} placeholder="src/shared/views.ts" type="text" value={fields.files} />
        </label>
      </div>
      {write.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {write.error.message}
        </p>
      ) : null}
      {asking && replacing !== undefined ? (
        <>
          <p className="launcher__lede">
            Lesson {replacing} is marked superseded. {STOPS_BEING_SERVED} The new lesson is served from the next turn.
          </p>
          <div className="launcher__row-actions">
            <button className="launcher__button launcher__button--danger" disabled={write.pending} onClick={submit} type="button">
              Replace lesson {replacing}
            </button>
            <button className="launcher__button" onClick={() => setAsking(false)} type="button">
              Back
            </button>
          </div>
        </>
      ) : (
        <div className="launcher__row-actions">
          <button className="launcher__button" disabled={write.pending} type="submit">
            {write.pending ? 'Writing…' : replacing === undefined ? 'Write lesson' : 'Replace…'}
          </button>
          <button className="launcher__button" onClick={onCancel} type="button">
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}

// ── Cases ────────────────────────────────────────────────────────────────────

function CasesView({ reload, onOpenLesson }: { reload: number; onOpenLesson(id: number): void }): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.knowledgeCases'>('launcher.knowledgeCases');
  const { run } = list;
  const [opened, setOpened] = useState<number | null>(null);
  useEffect(() => {
    void run({ limit: ROWS });
  }, [run, reload]);

  const cases = list.data?.cases ?? [];
  return (
    <>
      {list.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {list.error.message}
        </p>
      ) : null}
      {list.data !== null && cases.length === 0 ? (
        <p className="launcher__lede">No cases. A case opens when a build or a check the engineer runs fails.</p>
      ) : null}
      <ol className="launcher__log-list launcher__k-list">
        {cases.map((entry) => {
          const open = opened === entry.id;
          return (
            <li className="launcher__log-row" key={entry.id}>
              <button
                aria-expanded={open}
                className="launcher__k-line"
                onClick={() => setOpened(open ? null : entry.id)}
                type="button"
              >
                <span className="launcher__log-time">{when(entry.openedAt)}</span>
                <span className="launcher__log-where">
                  {entry.appId} · {entry.stage}
                </span>
                <span className="launcher__k-text">{head(entry.problem, 80)}</span>
                <span className="launcher__k-chips">
                  <Chip word={entry.resolvedAt === null ? 'open' : 'resolved'} />
                  {entry.diagnosis === null ? null : <Chip word={entry.diagnosis} />}
                  <Chip title="distillation" word={entry.distillState} />
                  {entry.lessonId === null ? null : <Chip word={`lesson ${String(entry.lessonId)}`} />}
                  <span className="launcher__k-counts" title="edits while open">
                    {entry.edits} edit(s)
                  </span>
                </span>
              </button>
              {open ? <CaseDetail id={entry.id} onOpenLesson={onOpenLesson} /> : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function CaseDetail({ id, onOpenLesson }: { id: number; onOpenLesson(id: number): void }): React.ReactElement {
  const detail = useOperation<LauncherContract, 'launcher.knowledgeCase'>('launcher.knowledgeCase');
  const { run } = detail;
  useEffect(() => {
    void run({ id });
  }, [run, id]);

  if (detail.error !== null) {
    return (
      <p className="launcher__message launcher__message--error" role="alert">
        {detail.error.message}
      </p>
    );
  }
  const found = detail.data?.case;
  if (found === undefined) return <p className="launcher__lede">Reading the case…</p>;
  return (
    <div className="launcher__k-detail">
      <pre className="launcher__log-data">{found.problem}</pre>
      <dl className="launcher__k-fields">
        <dt>Request</dt>
        <dd>{found.request ?? '(not recorded)'}</dd>
        <dt>Run</dt>
        <dd>
          <code>{found.runId}</code>
        </dd>
        <dt>Revisions</dt>
        <dd>
          <code>{found.sourceRevBefore}</code> → <code>{found.sourceRevAfter ?? 'not yet'}</code>
        </dd>
        <dt>Releases</dt>
        <dd>
          <code>{found.releaseBefore ?? 'none'}</code> → <code>{found.releaseAfter ?? 'none'}</code>
        </dd>
        <dt>Resolved</dt>
        <dd>{found.resolvedAt === null ? 'still open' : when(found.resolvedAt)}</dd>
        <dt>Diagnosis</dt>
        <dd>
          {found.diagnosis ?? 'none yet'}
          {found.reasoning === null ? '' : ` — ${found.reasoning}`}
        </dd>
        <dt>Lesson</dt>
        <dd>
          {found.lessonId === null ? (
            'none came of it'
          ) : (
            <button className="launcher__k-link" onClick={() => onOpenLesson(found.lessonId ?? 0)} type="button">
              lesson {found.lessonId}
            </button>
          )}
        </dd>
      </dl>
      <h3 className="launcher__k-heading">Edits while it was open</h3>
      {found.editLog === '' ? <p className="launcher__empty">None.</p> : <pre className="launcher__log-data">{found.editLog}</pre>}
    </div>
  );
}
