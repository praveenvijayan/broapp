/**
 * The interactive prompts.
 *
 * Hand-written rather than a dependency: three questions do not justify a
 * prompt library, and a generator with no runtime dependencies installs in one
 * step from a cold cache.
 *
 * Interactivity is decided by whether stdin is a TTY, not by a flag, so
 * `create-broapp app < /dev/null` in a script does not hang waiting for an
 * answer nobody is there to give.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** True when there is a human at the other end. */
export function isInteractive(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** A question and how to judge the answer. */
export interface Question {
  readonly message: string;
  readonly initial?: string;
  /** Returns an error message, or `null` when the answer is acceptable. */
  readonly validate?: (answer: string) => string | null;
}

/** Ask until the answer validates. Throws if stdin closes. */
export async function ask(question: Question): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const suffix = question.initial === undefined ? '' : ` (${question.initial})`;
      const raw = await readline.question(`${question.message}${suffix}: `);
      const answer = raw.trim() === '' ? (question.initial ?? '') : raw.trim();
      const problem = question.validate?.(answer) ?? null;
      if (problem === null) return answer;
      stdout.write(`  ${problem}\n`);
    }
  } finally {
    readline.close();
  }
}

/** Ask a yes/no question. */
export async function confirm(message: string, initial: boolean): Promise<boolean> {
  const answer = await ask({
    message: `${message} [${initial ? 'Y/n' : 'y/N'}]`,
    initial: initial ? 'y' : 'n',
    validate: (value) => (/^(?:y|yes|n|no)$/i.test(value) ? null : 'Answer y or n.'),
  });
  return /^y/i.test(answer);
}
