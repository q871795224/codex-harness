export function NumberBadge({ number, visible }: { number: number; visible: boolean }) {
  if (!visible) return null
  return <span className="number-badge" aria-hidden>{number}</span>
}
