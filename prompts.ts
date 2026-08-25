/**
 * Interactive surfaces, and the rule that keeps them from becoming a trap.
 *
 * Every prompt here has a flag that does the same thing. That is not a
 * courtesy — it is the contract. A CLI that only works when a human is
 * watching cannot be scripted, cannot run in CI, and cannot be driven by the
 * agent providers this tool now ships with. So:
 *
 *   1. **Nothing prompts unless stdin is a TTY.** `isInteractive()` gates every
 *      entry point, and a non-TTY caller gets an error naming the flag rather
 *      than a hang on a read that will never return.
 *   2. **A flag always wins.** If the answer was given, it is not asked for.
 *   3. **Cancelling is not confirming.** Clack returns a symbol for ctrl-c;
 *      treating it as a default is how a tool deletes something nobody agreed
 *      to. `orAbort` exits instead.
 *
 * Two things stay non-interactive on purpose, whatever the terminal:
 * `scan --adopt` still needs `--yes`, and accepting a proposal still refuses a
 * non-human actor. Confirmation that depends on whether stdin is a terminal is
 * confirmation that behaves differently in a script than in a session, and
 * both of those are decisions worth being able to grep for in a shell history.
 */

import * as p from "@clack/prompts";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.MECHANICS_NO_TTY;
}

/**
 * Refuse to prompt when nobody is there, and say which flag to pass instead.
 * The message is the whole value: "stdin is not a TTY" is a symptom, and
 * `--app=<slug>` is the answer.
 */
export function requireInteractive(what: string, flag: string): void {
  if (isInteractive()) return;
  throw new Error(
    `mechanics: ${what} needs a terminal. Pass ${flag} instead — every prompt has a flag.`
  );
}

/** Clack returns a symbol on ctrl-c. Never coerce that into an answer. */
export function orAbort<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("cancelled — nothing was written");
    process.exit(130);
  }
  return value as T;
}

export const intro = (title: string) => p.intro(title);
export const outro = (message: string) => p.outro(message);
export const note = (body: string, title?: string) => p.note(body, title);
export const log = p.log;
export const spinner = p.spinner;

/**
 * Values are primitives on purpose. Clack keys options by value, and an object
 * would compare by reference — a caller passing a freshly-built object each
 * render gets a list where nothing is ever selected.
 */
export type ChoiceValue = string | number | boolean;

export interface Choice<T extends ChoiceValue> {
  value: T;
  label: string;
  hint?: string;
}

// Clack's `Option<Value>` is a conditional type, which TypeScript cannot
// resolve through an unresolved generic even when the constraint guarantees
// the branch. The cast is confined to these two call sites rather than pushed
// onto every caller.
type ClackOptions<T> = Parameters<typeof p.select<T>>[0]["options"];

export async function select<T extends ChoiceValue>(
  message: string,
  options: Choice<T>[]
): Promise<T> {
  return orAbort(await p.select({ message, options: options as ClackOptions<T> }));
}

export async function multiselect<T extends ChoiceValue>(
  message: string,
  options: Choice<T>[],
  required = false
): Promise<T[]> {
  return orAbort(await p.multiselect({ message, options: options as ClackOptions<T>, required }));
}

export async function confirm(message: string, initialValue = false): Promise<boolean> {
  return orAbort(await p.confirm({ message, initialValue }));
}

export async function text(
  message: string,
  opts: {
    placeholder?: string;
    initialValue?: string;
    validate?: (v: string) => string | undefined;
  } = {}
): Promise<string> {
  return orAbort(
    await p.text({
      message,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue,
      validate: (v) => opts.validate?.(v ?? ""),
    })
  );
}

/**
 * Walk a list one item at a time with a per-item decision.
 *
 * Reviewing proposals is the case this exists for: a `multiselect` would make
 * "accept these twelve" one keystroke, which is exactly the wrong ergonomics —
 * each one is a separate judgment and the interface should cost what the
 * decision costs.
 */
export async function reviewEach<T>(
  items: T[],
  render: (item: T, index: number) => { title: string; body: string },
  choices: Choice<string>[]
): Promise<Array<{ item: T; choice: string }>> {
  const out: Array<{ item: T; choice: string }> = [];
  for (const [i, item] of items.entries()) {
    const { title, body } = render(item, i);
    p.note(body, `${i + 1}/${items.length}  ${title}`);
    const choice = await select(`What should happen to this?`, [
      ...choices,
      { value: "__skip", label: "Skip", hint: "leave it open" },
      { value: "__stop", label: "Stop reviewing", hint: "keep the rest for later" },
    ]);
    if (choice === "__stop") break;
    if (choice === "__skip") continue;
    out.push({ item, choice });
  }
  return out;
}
