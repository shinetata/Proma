/**
 * GreetingArtwork — 空会话问候语时段插画
 *
 * 手绘风格 SVG：早晨太阳、午后云、傍晚落日；夜间按月相实时变化。
 * SVG path 数据照抄商业版 0.22.0 产物反解，勿改数值。
 */

import * as React from 'react'

const DAY_MS = 86400000
const SYNODIC_MONTH = 29.530588
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14)

/** 月相：progress 0→1 为一个朔望月，illuminatedFraction 为照亮比例。 */
function getMoonPhase(date: Date): { progress: number; illuminatedFraction: number; waxing: boolean } {
  const time = date.getTime()
  if (!Number.isFinite(time)) throw new RangeError('无法计算无效日期的月相')
  const cycles = (time - NEW_MOON_EPOCH) / DAY_MS / SYNODIC_MONTH
  const progress = cycles - Math.floor(cycles)
  return {
    progress,
    illuminatedFraction: (1 - Math.cos(2 * Math.PI * progress)) / 2,
    waxing: progress < 0.5,
  }
}

type MoonTone = 'full' | 'warm' | 'cool' | 'muted'

function getMoonStyle(date: Date): { shape: 'full' | 'crescent'; direction: 'left' | 'right'; tone: MoonTone } {
  const { illuminatedFraction, waxing } = getMoonPhase(date)
  if (illuminatedFraction >= 0.995) return { shape: 'full', direction: 'left', tone: 'full' }
  return {
    shape: 'crescent',
    direction: waxing ? 'right' : 'left',
    tone: illuminatedFraction < 0.02 ? 'muted' : waxing ? 'warm' : 'cool',
  }
}

export type GreetingPeriod = 'night' | 'morning' | 'afternoon' | 'evening'

export function GreetingArtwork({ period, date }: { period: GreetingPeriod; date: Date }): React.ReactElement {
  const moon = period === 'night' ? getMoonStyle(date) : null
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="34"
      height="34"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="welcome-greeting-artwork text-foreground/55"
      data-period={period}
      data-moon-tone={moon?.tone}
      aria-hidden="true"
      focusable="false"
    >
      {period === 'morning' && (
        <>
          <path d="M20 37a12 12 0 0 1 24 0" fill="#dfa85c" fillOpacity="0.22" />
          <path d="M12 38h40M19 44h26M25 49h14M32 12v6M15 22l4 4M49 22l-4 4M10 31h5M49 31h5" />
        </>
      )}
      {period === 'afternoon' && (
        <>
          <circle cx="28" cy="26" r="10" fill="#dfa85c" fillOpacity="0.22" />
          <path d="M28 10v3M28 39v3M12 26h3M41 26h3M17 15l2 2M37 15l2-2M14 38l3-3" />
          <path d="M28 47h18a7 7 0 0 0 0-14 10 10 0 0 0-18-1 7.5 7.5 0 0 0 0 15Z" fill="hsl(var(--content-area, 0 0% 100%))" />
          <path d="M18 51h22" opacity="0.4" />
        </>
      )}
      {period === 'evening' && (
        <>
          <path d="M21 37a11 11 0 0 1 22 0" fill="#d98b72" fillOpacity="0.28" />
          <path d="M12 38h40M18 44h28M25 49h14M32 16v4M17 25l3 3M47 25l-3 3" />
          <path d="M28 13l4 3 4-3" opacity="0.5" />
        </>
      )}
      {moon && (
        <g stroke="var(--welcome-moon-stroke, currentColor)" fill="var(--welcome-moon-fill, #b8aed7)" fillOpacity={moon.shape === 'full' ? 0.3 : 0.22}>
          <g transform="translate(6.4 6.4) scale(0.8)">
            {moon.shape === 'full'
              ? <circle cx="32" cy="32" r="18" />
              : <path d="M39 12C24 11 12 23 14 37C16 52 34 60 47 49C34 50 24 40 24 28C24 21 30 15 39 12Z"
                  transform={moon.direction === 'right' ? 'translate(64 0) scale(-1 1)' : undefined} />}
          </g>
          <path d="m49 10 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" fill="none" strokeWidth="1.1" opacity="0.6" />
          <path d="M13 35.5v3M11.5 37h3" fill="none" strokeWidth="1" opacity="0.35" />
          <circle cx="54" cy="29" r="0.75" fill="var(--welcome-moon-stroke, currentColor)" fillOpacity="0.4" stroke="none" />
        </g>
      )}
    </svg>
  )
}
