/**
 * Telling a person something happened, when they are not looking.
 *
 * The launcher's questions are not like an application's. An application asks
 * while somebody is using it; the engineer asks after ten minutes of a model
 * thinking, by which time the tab is behind something else. Report 08b lost
 * two of six edits to exactly that — a question that arrived, waited, and
 * expired unread. A backlog run is longer still: a task fails, a run finishes,
 * a provider gives up, all while the person is somewhere else.
 *
 * Three nudges, all quiet. The tab renames itself, which is the one thing a
 * background tab can still say. A notification is raised only if the person
 * has *already* granted permission: asking for it is a dialogue nobody
 * invited, and a program that asks the moment it wants something is a program
 * people say no to. The one place permission is asked is
 * {@link requestAlerts}, which only the Notifications switch in Settings
 * calls; the same switch turned off stops the page raising any. And for the events that
 * need the person, a short generated tone, only when they have turned sound
 * on and are not looking at the tab — nobody looking at it is beeped at.
 */

/** The prefix a title carries while something is waiting, e.g. `(1) `. */
const PREFIX = /^\(\d+\)\s/;

/** A title with the pending count on the front, and without it at zero. */
export function titleWithPending(title: string, pending: number): string {
  const bare = title.replace(PREFIX, '');
  return pending > 0 ? `(${String(pending)}) ${bare}` : bare;
}

/** The two tones: rising for something that needs the person, one soft note for a run that ended. */
export type ToneKind = 'attention' | 'done';

/** A sound the surface can make. Injected so it can be tested. */
export interface SoundSurface {
  /** Whether the person has turned sound on. */
  enabled: boolean;
  play(kind: ToneKind): void;
  /** Called from a person's click, which is what lets a browser start audio. */
  unlock?(): void;
}

/** What {@link announcePending} and {@link announce} may touch. Injected so they can be tested. */
export interface PendingSurface {
  title: string;
  /** The browser's notification constructor, when there is one. */
  readonly notify?: {
    readonly permission: string;
    /**
     * Whether the person wants notifications: their switch in Settings. A
     * browser's permission cannot be given back by a page, so turning them
     * off is this flag, not the permission. Absent means on.
     */
    enabled?: boolean;
    raise(title: string, body: string): void;
    /** Ask for permission. Only {@link requestAlerts} calls it. */
    request?(): Promise<string>;
  };
  /** The generated tones, when the page has them. */
  readonly sound?: SoundSurface;
  /** Whether the person is looking: the document visible and focused. */
  attending?(): boolean;
  /** The alerts already raised, by key, for the life of the tab. */
  readonly raised?: Set<string>;
}

/**
 * Rename the surface, and raise a notification the first time a question
 * appears.
 *
 * `previous` is what the count was a moment ago, so a strip that keeps
 * reporting the same waiting question does not raise a notification a second
 * time. Returns nothing: this is the edge of the program.
 */
export function announcePending(
  surface: PendingSurface,
  pending: number,
  previous: number,
): void {
  surface.title = titleWithPending(surface.title, pending);
  if (pending <= previous || pending === 0) return;
  const notify = surface.notify;
  // Never `requestPermission()`. A permission that was not already given is an
  // answer, and asking again is how a tab becomes something people mute.
  if (notify === undefined || notify.permission !== 'granted' || notify.enabled === false) return;
  notify.raise(
    'Autoapp needs an answer',
    pending === 1
      ? 'The engineer is waiting for you to allow something.'
      : `${String(pending)} things are waiting for you.`,
  );
}

/** The six things an alert is raised for. */
export type AlertKind = 'question' | 'task-completed' | 'task-failed' | 'turn-limit' | 'run-ended' | 'provider-error';

/** One alert. */
export interface AlertEvent {
  /** Raised once per key for the life of the tab: the run id and the kind. */
  readonly key: string;
  readonly kind: AlertKind;
  readonly title: string;
  readonly body: string;
}

/**
 * Which tone an event gets: the ones that need the person, and the end of a
 * run. A completed task and a turn a limit ended get none — a retry or the
 * next task follows them, and nothing is asked of anybody.
 */
export const ALERT_TONES: Readonly<Record<AlertKind, ToneKind | null>> = {
  question: 'attention',
  'task-failed': 'attention',
  'provider-error': 'attention',
  'run-ended': 'done',
  'task-completed': null,
  'turn-limit': null,
};

/** The headline a notification carries for each event. */
const ALERT_TITLES: Readonly<Record<AlertKind, string>> = {
  question: 'Autoapp needs an answer',
  'task-completed': 'A task is built',
  'task-failed': 'A task failed',
  'turn-limit': 'A turn was ended by a limit',
  'run-ended': 'The backlog run ended',
  'provider-error': 'The AI provider returned an error',
};

/**
 * Raise one alert, once. Exported as `announce`, the name 17a gives it;
 * written as `raiseAlert` here so that a scan for the event log's
 * `announce` — the one call that may print a launch address whole — finds
 * only that.
 *
 * A notification when permission was already granted; a tone when sound is on,
 * the event has one, and the person is not looking. The two are separate: a
 * browser that blocks notifications can still play a tone. A tone that fails
 * to play fails quietly — an alert is never why something else breaks.
 */
function raiseAlert(surface: PendingSurface, event: AlertEvent): void {
  const raised = surface.raised;
  if (raised !== undefined) {
    if (raised.has(event.key)) return;
    raised.add(event.key);
  }
  const notify = surface.notify;
  // Never `requestPermission()` here: see `announcePending`.
  if (notify !== undefined && notify.permission === 'granted' && notify.enabled !== false) {
    try {
      notify.raise(event.title, event.body);
    } catch {
      // A notification that could not be shown is not the page's failure.
    }
  }
  const tone = ALERT_TONES[event.kind];
  const sound = surface.sound;
  if (tone === null || sound === undefined || !sound.enabled) return;
  if (surface.attending?.() === true) return;
  try {
    sound.play(tone);
  } catch {
    // Silent, as a browser that will not start audio is.
  }
}

export { raiseAlert as announce };

/** What {@link alertsBetween} reads of `launcher.overview`. */
export interface OverviewAlerts {
  readonly needsYou: readonly {
    readonly key: string;
    readonly kind: string;
    readonly title: string;
    readonly detail: string;
  }[];
  readonly recent: readonly {
    readonly key: string;
    readonly kind: 'task-completed' | 'task-failed' | 'turn-limit' | 'run-ended' | 'provider-error';
    readonly text: string;
  }[];
}

/**
 * The alerts two successive reads of the overview call for: a question that
 * was not waiting before, and a run event that was not there before. The first
 * read is the baseline and raises nothing — what happened before the tab
 * looked is on the screen, not news.
 */
export function alertsBetween(previous: OverviewAlerts | null, next: OverviewAlerts): AlertEvent[] {
  if (previous === null) return [];
  const before = new Set([...previous.needsYou.map((item) => item.key), ...previous.recent.map((event) => event.key)]);
  const out: AlertEvent[] = [];
  for (const item of next.needsYou) {
    if (item.kind !== 'question' || before.has(item.key)) continue;
    out.push({ key: item.key, kind: 'question', title: ALERT_TITLES.question, body: item.title });
  }
  // Oldest first, so a task's failure is heard before the run's end.
  for (const event of [...next.recent].reverse()) {
    if (before.has(event.key)) continue;
    out.push({ key: event.key, kind: event.kind, title: ALERT_TITLES[event.kind], body: event.text });
  }
  return out;
}

/**
 * One read of the overview's worth of telling: the title counts everything
 * that needs the person, not only questions, and each new event is announced.
 */
export function announceOverview(surface: PendingSurface, previous: OverviewAlerts | null, next: OverviewAlerts): AlertEvent[] {
  surface.title = titleWithPending(surface.title, next.needsYou.length);
  const events = alertsBetween(previous, next);
  for (const event of events) raiseAlert(surface, event);
  return events;
}

/**
 * Ask for permission to notify, once, from a person's click.
 *
 * The only caller of `request()` anywhere: a button the person pressed, never
 * a render, a read or an event. It asks only while the browser has no answer;
 * after that the answer stands and is reported. The same click is the gesture
 * that lets the page start audio. Resolves with the permission, or
 * `unsupported` when there is no notification to ask about.
 */
export async function requestAlerts(surface: PendingSurface): Promise<string> {
  try {
    surface.sound?.unlock?.();
  } catch {
    // No audio is not a reason to refuse notifications.
  }
  const notify = surface.notify;
  if (notify === undefined) return 'unsupported';
  if (notify.permission !== 'default' || notify.request === undefined) return notify.permission;
  try {
    return await notify.request();
  } catch {
    return notify.permission;
  }
}

/** The Web Audio API as this file uses it, so a missing one is a type and not a crash. */
interface AudioLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(value: number, at: number): void };
    connect(target: unknown): void;
    start(at: number): void;
    stop(at: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, at: number): void;
      linearRampToValueAtTime(value: number, at: number): void;
      exponentialRampToValueAtTime(value: number, at: number): void;
    };
    connect(target: unknown): void;
  };
}

/** The notes of each tone: frequency in hertz, start and length in seconds. */
const TONES: Readonly<Record<ToneKind, readonly { hz: number; at: number; length: number }[]>> = {
  // Two notes a fifth apart, rising: something is waiting.
  attention: [
    { hz: 660, at: 0, length: 0.14 },
    { hz: 990, at: 0.16, length: 0.18 },
  ],
  // One soft note: it ended.
  done: [{ hz: 523, at: 0, length: 0.3 }],
};

/** The loudest a tone gets: quiet, because it plays when nobody chose to listen. */
const PEAK_GAIN = 0.12;

/**
 * Two short generated tones, made with the Web Audio API: no audio file, no
 * asset, no network. Each note fades in over ten milliseconds and out to
 * silence, so it never clicks, and neither tone lasts 400 ms.
 *
 * A browser that will not start audio — no gesture yet, or no `AudioContext`
 * at all — is silent without an error. `unlock` is called from the person's
 * click, which is what a browser needs to let the context run.
 */
export function webAudioSound(): SoundSurface {
  let context: AudioLike | null = null;
  const contextOf = (): AudioLike | null => {
    if (context !== null) return context;
    const scope = globalThis as { AudioContext?: new () => AudioLike; webkitAudioContext?: new () => AudioLike };
    const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
    if (Constructor === undefined) return null;
    try {
      context = new Constructor();
    } catch {
      return null;
    }
    return context;
  };
  return {
    enabled: false,
    unlock() {
      const audio = contextOf();
      if (audio !== null && audio.state !== 'running') void audio.resume().catch(() => undefined);
    },
    play(kind) {
      const audio = contextOf();
      if (audio === null || audio.state !== 'running') return;
      const start = audio.currentTime + 0.01;
      for (const note of TONES[kind]) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.hz, start + note.at);
        gain.gain.setValueAtTime(0.0001, start + note.at);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + note.at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(start + note.at);
        oscillator.stop(start + note.at + note.length + 0.02);
      }
    },
  };
}

/** The one surface a tab has, so what it has raised is remembered for its life. */
let surfaceOfTab: PendingSurface | null = null;

/** The browser's own surface, or `null` when there is no document. */
export function browserSurface(): PendingSurface | null {
  if (typeof document === 'undefined') return null;
  if (surfaceOfTab !== null) return surfaceOfTab;
  const constructor = (globalThis as { Notification?: typeof Notification }).Notification;
  surfaceOfTab = {
    get title() {
      return document.title;
    },
    set title(value: string) {
      document.title = value;
    },
    ...(constructor === undefined
      ? {}
      : {
          notify: {
            enabled: true,
            get permission() {
              return constructor.permission;
            },
            raise: (title: string, body: string) => void new constructor(title, { body }),
            request: () => constructor.requestPermission(),
          },
        }),
    sound: webAudioSound(),
    attending: () => document.visibilityState === 'visible' && document.hasFocus(),
    raised: new Set<string>(),
  };
  return surfaceOfTab;
}
