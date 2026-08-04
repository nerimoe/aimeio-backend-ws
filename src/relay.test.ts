import { describe, expect, it } from 'vitest'
import { normalizeStateMessage } from './relay'

describe('normalizeStateMessage', () => {
  it('wraps a legacy card without an action as SET_CARD', () => {
    expect(normalizeStateMessage({ type: 'aime', value: '0102' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'aime', value: '0102' },
    })
  })

  it('forwards an action message without inspecting its body', () => {
    const message = {
      action: 'E2EE_V1',
      body: { ciphertext: 'opaque' },
    }

    expect(normalizeStateMessage(message)).toBe(message)
  })

  it('forwards unknown action names without a whitelist', () => {
    const message = { action: 'FUTURE_COMMAND', body: { value: 'opaque' } }

    expect(normalizeStateMessage(message)).toBe(message)
  })
})
