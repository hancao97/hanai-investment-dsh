/**
 * pnpm forwards the conventional `pnpm run <script> -- ...` separator to the
 * child script. Remove only that leading separator; a later `--` remains a
 * real argument and is still rejected by each command's parser.
 */
export function stripPnpmRunSeparator(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args]
}
