import { useState } from 'react'
import { cn } from '@/lib/cn'
import { useI18n } from '@/i18n/useI18n'

/**
 * TopologyMini — a clickable architecture topology diagram.
 *
 * Clicking a node promotes it to "active" and lights up the edges that touch it,
 * so the card reads as a real interactive diagram rather than a static picture.
 *
 * ── Choosing SVG over divs ────────────────────────────────────────────────
 * Edges are diagonal, so they need real line geometry. Doing this with rotated
 * divs would mean computing transforms by hand and would break on resize; SVG
 * lines scale cleanly with the viewBox and need no measurement at all.
 *
 * ── Why the layout is a constant ─────────────────────────────────────────
 * Node coordinates are authored by hand in viewBox units instead of being
 * measured or force-laid-out. It renders identically at every size, costs
 * nothing at runtime, and keeps the component free of layout effects.
 */

interface TopologyNode {
  id: TopologyNodeId
  label: string
  x: number
  y: number
  /** Short role caption shown under the diagram when active. */
}

/** Closed union: every node id is also a key into the localised role table. */
type TopologyNodeId = 'edge' | 'gateway' | 'router' | 'worker' | 'cache' | 'store'

interface TopologyEdge {
  from: TopologyNodeId
  to: TopologyNodeId
}

/** Hand-authored layout in viewBox units (0 0 240 130). */
const NODES: TopologyNode[] = [
  { id: 'edge', label: 'EDGE', x: 30, y: 65 },
  { id: 'gateway', label: 'GW', x: 88, y: 30 },
  { id: 'router', label: 'ROUTE', x: 88, y: 100 },
  { id: 'worker', label: 'WORK', x: 150, y: 30 },
  { id: 'cache', label: 'CACHE', x: 150, y: 100 },
  { id: 'store', label: 'STORE', x: 212, y: 65 },
]

const EDGES: TopologyEdge[] = [
  { from: 'edge', to: 'gateway' },
  { from: 'edge', to: 'router' },
  { from: 'gateway', to: 'worker' },
  { from: 'router', to: 'cache' },
  { from: 'worker', to: 'store' },
  { from: 'cache', to: 'store' },
  { from: 'gateway', to: 'router' },
]

interface TopologyMiniProps {
  className?: string
}

export function TopologyMini({ className }: TopologyMiniProps) {
  const { t } = useI18n()
  const [activeId, setActiveId] = useState<TopologyNodeId>('worker')
  /*
   * Which node holds keyboard focus.
   *
   * Driven by React state rather than CSS on purpose: two measured attempts at a
   * CSS-only ring failed on this element (`focus:outline-*` resolved to
   * `outline-style: none`, and an injected `:focus > circle` rule did not match at
   * all). An explicit element cannot be defeated by an engine's SVG quirks, and it is
   * verifiable: focus a node and count rings.
   */
  const [focusedId, setFocusedId] = useState<TopologyNodeId | null>(null)

  const nodeById = (id: string): TopologyNode | undefined =>
    NODES.find((n) => n.id === id)

  const isEdgeActive = (edge: TopologyEdge): boolean =>
    edge.from === activeId || edge.to === activeId

  const activeNode = nodeById(activeId)

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[0.6rem] tracking-[0.2em] text-ink-700 uppercase">
          topology
        </span>
        <span className="font-mono text-[0.55rem] text-ink-700">{t.bento.topologyHint}</span>
      </div>

      <svg
        viewBox="0 0 240 130"
        className="mt-2 w-full flex-1"
        role="img"
        aria-label={t.bento.topologyAria}
      >
        {/* Edges first so nodes paint on top. */}
        {EDGES.map((edge) => {
          const a = nodeById(edge.from)
          const b = nodeById(edge.to)
          if (!a || !b) return null
          const active = isEdgeActive(edge)
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={active ? 'rgba(16, 185, 129, 0.85)' : 'rgba(42, 51, 72, 0.9)'}
              strokeWidth={active ? 1.4 : 1}
              vectorEffect="non-scaling-stroke"
              className="transition-all duration-300"
            />
          )
        })}

        {NODES.map((node) => {
          const active = node.id === activeId
          return (
            <g
              key={node.id}
              onClick={() => setActiveId(node.id)}
              role="button"
              tabIndex={0}
              aria-label={`${node.label} — ${t.bento.topologyRoles[node.id]}`}
              aria-pressed={active}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveId(node.id)
                }
              }}
              /*
               * The focus ring was explicitly removed here, which left keyboard users
               * with no indication of which node they were on (WCAG 2.4.7). The ring
               * is drawn on the circle below via `focus-visible` rather than the SVG
               * group, because outlines on SVG shapes are unreliable across engines.
               */
              /*
               * `focus:` rather than `focus-visible:` on purpose. This node is only
               * reachable by keyboard (it is a `role=button` group with a tabIndex),
               * so there is no "mouse focus" case to suppress -- and `focus-visible`
               * does not match reliably on SVG groups, which is how the ring ended up
               * measuring `outline-style: none` while the element was focused.
               */
              onFocus={() => setFocusedId(node.id)}
              onBlur={() => setFocusedId(null)}
              className="cursor-pointer"
            >
              {/*
                * Focus ring. A real element, so no engine can refuse to paint it.
                * Dashed so it reads as "keyboard focus" rather than as the active
                * state, which is already shown by the halo below.
                */}
              {focusedId === node.id && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={15}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={1.5}
                  strokeDasharray="3 2.5"
                  className="pointer-events-none"
                />
              )}

              {/* Halo */}
              <circle
                cx={node.x}
                cy={node.y}
                r={active ? 13 : 9}
                fill={active ? 'rgba(16, 185, 129, 0.16)' : 'transparent'}
                className="transition-all duration-300"
              />
              {/* Dot */}
              <circle
                cx={node.x}
                cy={node.y}
                r={active ? 5 : 3.8}
                fill={active ? '#34d399' : '#2a3348'}
                stroke={active ? '#6ee7b7' : '#7c8aa6'}
                strokeWidth={0.9}
                className="transition-all duration-300"
              />
              <text
                x={node.x}
                y={node.y - 13}
                textAnchor="middle"
                className={cn(
                  'font-mono transition-all duration-300',
                  active ? 'fill-[#6ee7b7]' : 'fill-[#7c8aa6]',
                )}
                style={{ fontSize: 7.5, letterSpacing: '0.06em' }}
              >
                {node.label}
              </text>
            </g>
          )
        })}
      </svg>

      <p className="mt-1 min-h-4 font-mono text-[0.6rem] text-ink-500">
        <span className="text-signal-teal">{activeNode?.label}</span>
        <span className="mx-1.5 text-ink-700">·</span>
        {activeNode ? t.bento.topologyRoles[activeNode.id] : ''}
      </p>
    </div>
  )
}

export default TopologyMini
