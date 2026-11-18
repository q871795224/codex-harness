import { MessageCircle } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'

type Point = { left: number; top: number }

function inViewport(position: Point, element: HTMLElement): Point {
  return {
    left: Math.max(0, Math.min(position.left, window.innerWidth - element.offsetWidth)),
    top: Math.max(0, Math.min(position.top, window.innerHeight - element.offsetHeight)),
  }
}

export function AssistantLauncher({ buttonRef, hidden, onOpen }: { buttonRef: RefObject<HTMLButtonElement>; hidden: boolean; onOpen(): void }) {
  const [position, setPosition] = useState<Point>()
  const drag = useRef<{ id: number; x: number; y: number; origin: Point }>()
  const moved = useRef(false)
  useEffect(() => {
    if (hidden) return
    const constrain = () => {
      const button = buttonRef.current
      if (button) setPosition(current => current && inViewport(current, button))
    }
    constrain()
    window.addEventListener('resize', constrain)
    return () => window.removeEventListener('resize', constrain)
  }, [buttonRef, hidden])

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current) return
    moved.current = false
    const bounds = event.currentTarget.getBoundingClientRect()
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { left: bounds.left, top: bounds.top } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!moved.current && Math.hypot(dx, dy) < 5) return
    moved.current = true
    setPosition(inViewport({ left: current.origin.left + dx, top: current.origin.top + dy }, event.currentTarget))
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.id === event.pointerId) drag.current = undefined
  }

  return <button ref={buttonRef} type="button" className="harness-assistant-launcher" title="打开 Harness 助理" aria-haspopup="dialog" hidden={hidden}
    style={position && { ...position, right: 'auto', bottom: 'auto' }}
    onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onClick={event => { if (event.detail === 0 || !moved.current) onOpen() }}>
    <MessageCircle size={17} />助理
  </button>
}
