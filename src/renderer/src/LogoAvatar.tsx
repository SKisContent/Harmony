import type { ReactElement } from 'react'

// Fallback avatar: the Harmony wavy-H mark on a per-user background colour.
// Shown wherever a user or conversation has no image of their own; the colour is
// derived from a stable seed (a user or channel id) so the same person always
// gets the same swatch.

const PALETTE = [
  '#5865F2', '#3BA55D', '#ED4245', '#FAA61A', '#9B59B6', '#1ABC9C',
  '#E91E63', '#2E86DE', '#E67E22', '#00A8A8', '#7F5AF0', '#D6336C',
  '#0FB9B1', '#F76707', '#4C6EF5', '#12B886'
]

/** Deterministic, stable palette pick for a given id/string (FNV-1a). */
export function avatarColor(seed: string): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return PALETTE[(h >>> 0) % PALETTE.length]
}

export function LogoAvatar({
  seed,
  className = 'dm-avatar'
}: {
  seed: string
  className?: string
}): ReactElement {
  return (
    <svg className={className} viewBox="0 0 1024 1024" role="img" aria-hidden="true">
      <rect width="1024" height="1024" fill={avatarColor(seed)} />
      <g fill="#fff">
        <rect x="296" y="264" width="96" height="496" rx="48" />
        <rect x="632" y="264" width="96" height="496" rx="48" />
      </g>
      <path
        d="M344 512 C400 448 456 448 512 512 C568 576 624 576 680 512"
        fill="none"
        stroke="#fff"
        strokeWidth="96"
        strokeLinecap="round"
      />
    </svg>
  )
}
