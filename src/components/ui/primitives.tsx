import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/* -------------------------------------------------------------------------- */
/*  IconButton — square, terminal-style control used across the HUD           */
/* -------------------------------------------------------------------------- */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  children: ReactNode
}

export function IconButton({
  label,
  active = false,
  children,
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'group relative grid size-9 place-items-center rounded-[0.6rem] border transition-all duration-200',
        'border-void-600/80 bg-void-850/60 text-ink-300',
        'hover:border-signal-cyan/50 hover:text-signal-cyan',
        'focus-visible:border-signal-cyan',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active &&
          'border-signal-cyan/60 bg-signal-cyan/10 text-signal-cyan shadow-[0_0_18px_-4px_var(--color-signal-cyan)]',
        className,
      )}
      {...props}
    >
      {children}
      {/* corner tick — tiny geek detail */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-1 bottom-1 size-1 rounded-full transition-colors',
          active ? 'bg-signal-cyan' : 'bg-void-500 group-hover:bg-signal-cyan/70',
        )}
      />
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/*  StatusDot — the blinking "system alive" LED                               */
/* -------------------------------------------------------------------------- */
export function StatusDot({
  tone = 'cyan',
  pulse = true,
  className,
}: {
  tone?: 'cyan' | 'teal' | 'violet' | 'amber' | 'rose'
  pulse?: boolean
  className?: string
}) {
  const tones: Record<string, string> = {
    cyan: 'bg-signal-cyan',
    teal: 'bg-signal-teal',
    violet: 'bg-signal-violet',
    amber: 'bg-signal-amber',
    rose: 'bg-signal-rose',
  }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 rounded-full',
        tones[tone],
        pulse && 'animate-pulse-dot',
        className,
      )}
    />
  )
}

/* -------------------------------------------------------------------------- */
/*  Divider — hairline with a centered glyph                                  */
/* -------------------------------------------------------------------------- */
export function Hairline({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('h-px w-full bg-gradient-to-r from-transparent via-void-500 to-transparent', className)}
    />
  )
}
