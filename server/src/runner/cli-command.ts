/**
 * Resolves how to launch the Claude Code CLI. A path to a JavaScript file (e.g. a cli.js or a test
 * stand-in) is run with the current Node binary: Windows cannot execute scripts directly (spawn
 * fails with EFTYPE), and going through Node avoids relying on a shebang elsewhere too.
 */
export function cliCommand(bin: string, args: string[]): { file: string; args: string[] } {
  if (/\.[cm]?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args] };
  return { file: bin, args };
}
