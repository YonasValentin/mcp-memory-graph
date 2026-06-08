/** ANSI escape: green foreground (used for `[ok]` and success banners). */
export const GREEN = '\x1b[32m';
/** ANSI escape: yellow foreground (used for `[!!]` warnings). */
export const YELLOW = '\x1b[33m';
/** ANSI escape: cyan foreground (used for `[->]` info and section banners). */
export const CYAN = '\x1b[36m';
/** ANSI escape: dim/faint text (used for secondary detail lines). */
export const DIM = '\x1b[2m';
/** ANSI escape: reset all attributes. */
export const RESET = '\x1b[0m';

/** Prints a green `[ok]`-tagged success line. */
export function success(msg: string): void {
  console.log(`${GREEN}[ok]${RESET} ${msg}`);
}

/** Prints a yellow `[!!]`-tagged warning line. */
export function warn(msg: string): void {
  console.log(`${YELLOW}[!!]${RESET} ${msg}`);
}

/** Prints a cyan `[->]`-tagged informational line. */
export function info(msg: string): void {
  console.log(`${CYAN}[->]${RESET} ${msg}`);
}

/** Prints a dim, indented secondary-detail line. */
export function dim(msg: string): void {
  console.log(`${DIM}    ${msg}${RESET}`);
}
