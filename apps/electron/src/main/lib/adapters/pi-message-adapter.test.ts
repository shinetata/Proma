import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage } from '@proma/shared'
import {
  convertPiMessage,
  convertResultMessage,
  getPiAssistantErrorDetails,
  hasPiAssistantTextContent,
  stripPiAssistantError,
  TOOL_USE_WITHOUT_TOOL_CALL_ERROR,
} from './pi-message-adapter'

function writeToolCall(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as AssistantMessage
}

describe('convertPiMessage', () => {
  test('keeps complete write input in the final tool-call frame', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1', undefined, {
      uuid: 'assistant-1',
    }) as { message: { content: Array<{ input?: Record<string, unknown> }> } }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('only exposes terminal Pi errors', () => {
    const providerError = 'Connection error. Failed to fetch'
    const nonTerminal = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: unknown }
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(nonTerminal.error).toBeUndefined()
    expect(terminalError.error).toEqual({
      message: providerError,
      errorType: 'network_error',
    })
  })

  test('classifies a malformed upstream JSON response as service_error', () => {
    const errorMessage = 'Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'service_error' })
  })

  test('keeps non-network terminal Pi errors as provider_error', () => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded',
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: '529 overloaded', errorType: 'provider_error' })
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
  ])('classifies terminal Pi transport error "%s" as network_error', (errorMessage) => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'network_error' })
  })

  test('keeps generated text separate from a terminal transport error', () => {
    const body = 'Generated assistant output must not appear inside the error card.'
    const transportError = 'peer closed connection without sending complete message body (incomplete chunked read)'
    const terminalError = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: body }],
      stopReason: 'error',
      errorMessage: transportError,
    } as unknown as AssistantMessage, 'session-1') as SDKAssistantMessage

    expect(getPiAssistantErrorDetails(terminalError)).toEqual({
      detailedMessage: transportError,
      originalError: transportError,
    })
    expect(hasPiAssistantTextContent(terminalError)).toBe(true)
    expect(stripPiAssistantError(terminalError).error).toBeUndefined()
    expect(terminalError.message.content).toEqual([{ type: 'text', text: body }])
    expect(terminalError.error).toEqual({ message: transportError, errorType: 'network_error' })
  })

  test('only reports result errors for terminal Pi failures', () => {
    const providerError = 'stream ended before a terminal response event'
    const partialStop = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }
    const terminalError = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }

    expect(partialStop.subtype).toBe('success')
    expect(partialStop.errors).toBeUndefined()
    expect(terminalError.subtype).toBe('error_during_execution')
    expect(terminalError.errors).toEqual([providerError])
  })

  test('reports a toolUse stop without any tool call as an execution error', () => {
    const missingToolCall = convertResultMessage([{
      role: 'assistant',
      content: [{ type: 'text', text: '我把这些交给原来的子会话补。' }],
      stopReason: 'toolUse',
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[]; terminal_reason?: string }
    const normalToolUse = convertResultMessage([{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
      stopReason: 'toolUse',
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }
    const guarded = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'toolUse',
    } as unknown as AssistantMessage], 'session-1', {
      subtype: 'error_max_turns', terminalReason: 'max_turns', errors: ['max turns'],
    }) as { subtype?: string; errors?: string[] }

    expect(missingToolCall.subtype).toBe('error_during_execution')
    expect(missingToolCall.errors).toEqual([TOOL_USE_WITHOUT_TOOL_CALL_ERROR])
    expect(missingToolCall.terminal_reason).toBe('completed')
    expect(normalToolUse.subtype).toBe('success')
    expect(normalToolUse.errors).toBeUndefined()
    expect(guarded.subtype).toBe('error_max_turns')
    expect(guarded.errors).toEqual(['max turns'])
  })
})
