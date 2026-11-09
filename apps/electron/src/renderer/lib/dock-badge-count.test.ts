import { describe, expect, test } from 'bun:test'
import { calculateDockBadgeCount, countPendingRequests } from './dock-badge-count'

describe('Dock 角标计数', () => {
  test('given no attention items when calculating badge count then returns zero', () => {
    const count = calculateDockBadgeCount({
      unviewedCompletedCount: 0,
      pendingAskUserCount: 0,
    })

    expect(count).toBe(0)
  })

  test('given completed sessions and pending requests when calculating badge count then returns their total', () => {
    const count = calculateDockBadgeCount({
      unviewedCompletedCount: 2,
      pendingAskUserCount: 1,
    })

    expect(count).toBe(3)
  })

  test('given requests grouped by session when counting pending requests then sums all queues', () => {
    const requestsBySession = new Map<string, readonly string[]>([
      ['session-a', ['ask-user-a', 'ask-user-b']],
      ['session-b', []],
      ['session-c', ['ask-user-c']],
    ])

    expect(countPendingRequests(requestsBySession)).toBe(3)
  })
})