/**
 * The class-name helper the vendored components expect.
 *
 * shadcn's own registry imports this from `@/lib/utils`; the AI Elements files
 * import it from the same place. It is written out here rather than pulled
 * from a package so the package's dependency list stays short and readable.
 */
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Join class names, letting a later Tailwind utility win over an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
