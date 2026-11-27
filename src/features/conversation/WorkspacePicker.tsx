import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Workspace } from '../../core/domain/codex'

interface WorkspacePickerProps {
  value: string
  workspaces: Workspace[]
  allowAutomatic: boolean
  disabled: boolean
  onChange: (root: string) => void
  onChooseDirectory: () => void
}

export function WorkspacePicker({ value, workspaces, allowAutomatic, disabled, onChange, onChooseDirectory }: WorkspacePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const listId = useId()
  const listRef = useRef<HTMLSpanElement>(null)
  const keyword = query.trim().toLocaleLowerCase()
  const chooseDirectoryValue = '__choose_directory__'
  const label = workspaces.find((workspace) => workspace.root === value)?.name ?? (allowAutomatic ? '自动选择工作区' : '当前工作区')
  const options = [
    ...(allowAutomatic || !value ? [{ value: '', label: allowAutomatic ? '自动选择工作区' : '当前工作区', path: '', matches: true }] : []),
    ...workspaces.map((workspace) => ({
      value: workspace.root,
      label: workspace.name,
      path: workspace.root,
      matches: `${workspace.name}\n${workspace.root}`.toLocaleLowerCase().includes(keyword),
    })),
    { value: chooseDirectoryValue, label: '… 选择其他目录', path: '', matches: true },
  ]
  const available = options.filter((option) => option.matches)
  const activeIndex = options.findIndex((option) => option.value === activeValue && option.matches)

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (open && activeIndex >= 0) listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, query])

  function showOptions() {
    if (disabled || open) return
    setQuery('')
    setActiveValue(value)
    setOpen(true)
  }

  function choose(nextValue: string) {
    if (disabled || !options.some((option) => option.value === nextValue && option.matches)) return
    setOpen(false)
    setQuery('')
    if (nextValue === chooseDirectoryValue) onChooseDirectory()
    else onChange(nextValue)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { showOptions(); return }
      const index = available.findIndex((option) => option.value === activeValue)
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : available.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length
      setActiveValue(available[next]?.value ?? null)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      if (activeIndex >= 0) choose(options[activeIndex].value)
    }
  }

  return (
    <span className="fresh-workspace-select workspace-picker" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <input
        role="combobox"
        aria-label="切换新会话工作区"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : label}
        placeholder={open ? '输入名称或路径' : label}
        title={value || label}
        onFocus={showOptions}
        onClick={showOptions}
        onChange={(event) => {
          const nextQuery = event.target.value
          const nextKeyword = nextQuery.trim().toLocaleLowerCase()
          setQuery(nextQuery)
          setOpen(true)
          setActiveValue(nextKeyword ? workspaces.find((workspace) => `${workspace.name}\n${workspace.root}`.toLocaleLowerCase().includes(nextKeyword))?.root ?? null : value)
        }}
        onKeyDown={handleKeyDown}
      />
      <ChevronDown size={14} aria-hidden />
      {open && <span className="workspace-picker-menu">
        {keyword && !options.some((option) => option.path && option.matches) && <span className="workspace-picker-empty" role="status">没有匹配的工作区</span>}
        <span id={listId} role="listbox" aria-label="工作区" ref={listRef} className="workspace-picker-options">
          {options.map((option, index) => <span
            key={option.value}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={!option.matches}
            className={`workspace-picker-option${index === activeIndex ? ' active' : ''}`}
            title={option.path || option.label}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => { if (option.matches) setActiveValue(option.value) }}
            onClick={() => choose(option.value)}
          >
            <span>{option.label}</span>
            {option.path && <small>{option.path}</small>}
          </span>)}
        </span>
      </span>}
    </span>
  )
}
