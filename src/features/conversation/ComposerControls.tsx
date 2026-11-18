import { Send } from 'lucide-react'
import { forwardRef, useLayoutEffect, type ComponentPropsWithoutRef, type RefObject } from 'react'
import type { SendShortcut } from '../../core/domain/codex'
import { matchesSendShortcut } from './composerInput'

interface ComposerTextareaProps extends ComponentPropsWithoutRef<'textarea'> {
  textareaRef: RefObject<HTMLTextAreaElement>
  highlightRef?: RefObject<HTMLDivElement>
  composing?: boolean
  sendShortcut: SendShortcut
  onSendShortcut(): void
}

export function ComposerTextarea({ textareaRef, highlightRef, composing, sendShortcut, onSendShortcut, onKeyDown, ...props }: ComposerTextareaProps) {
  const { value } = props
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || composing) return
    const maximumHeight = 124
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, maximumHeight)
    textarea.style.height = `${Math.max(28, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
    if (highlightRef?.current) {
      highlightRef.current.style.width = `${textarea.clientWidth}px`
      highlightRef.current.scrollTop = textarea.scrollTop
    }
  }, [composing, highlightRef, textareaRef, value])

  return <textarea {...props} ref={textareaRef} rows={1} wrap="soft" onKeyDown={event => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !matchesSendShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }, sendShortcut)) return
    event.preventDefault()
    onSendShortcut()
  }} />
}

export const ComposerSendButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(
  function ComposerSendButton({ children, className = '', type = 'button', ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={`send-button${className ? ` ${className}` : ''}`}>
      {children ?? <Send size={17} />}
    </button>
  },
)
