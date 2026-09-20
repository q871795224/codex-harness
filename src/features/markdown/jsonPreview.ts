// Keep expensive trees and numbers that JavaScript cannot represent safely in source view.
export function parseJsonPreview(code: string): object | null {
  if (code.length > 100_000) return null
  let depth = 0
  let tokens = 0
  // Consume strings as a unit so braces and digits inside them are not inspected.
  const tokenPattern = /"(?:[^"\\]|\\.)*"|[{}\[\]]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g
  for (const [token] of code.matchAll(tokenPattern)) {
    if (++tokens > 5_000) return null
    if (token === '{' || token === '[') {
      if (++depth > 64) return null
    } else if (token === '}' || token === ']') {
      depth--
    } else if (/^-?\d/.test(token)) {
      const number = Number(token)
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) return null
    }
  }
  try {
    const value: unknown = JSON.parse(code)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}
