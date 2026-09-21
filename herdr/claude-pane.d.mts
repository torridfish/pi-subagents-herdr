/** Types for `claude-pane.mjs`, which is plain Node because a pane spawns it
 *  directly — there is no build step between here and the pane. */
import type { ChildProcess } from "node:child_process";

/**
 * Wire a spawned headless `claude` into the pane it is running in: its stdout
 * to the journal the parent tails and to the pane's terminal, the pane's
 * keystrokes to its stdin, and its stdin closed when a turn settles with no
 * question outstanding.
 */
export function attachClaudeBridge(child: ChildProcess, directory: string, openingPrompt: string): void;
