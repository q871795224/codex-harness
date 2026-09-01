const SHELL_COMMAND_PREFIX = /^(?:(?:\/usr)?\/bin\/)?(?:zsh|bash|sh)\s+(?:-lc|-l\s+-c|--login\s+-c|-c)\s+([\s\S]+)$/

export function displayCommand(command: string): string {
  const normalized = command.trim()
  const match = normalized.match(SHELL_COMMAND_PREFIX)
  if (!match) return normalized
  return unwrapShellArgument(match[1]).trim() || normalized
}

function unwrapShellArgument(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 2) return normalized
  const first = normalized[0]
  const last = normalized.at(-1)
  if (first !== last || (first !== '"' && first !== "'")) return normalized
  const inner = normalized.slice(1, -1)
  return first === '"'
    ? inner.replace(/\\([\\"])/g, '$1')
    : inner.replace(/\\'/g, "'")
}
