import { describe, expect, it } from 'vitest'
import { messageForClient, normalizeStateMessage } from './relay'

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

describe('messageForClient', () => {
  const v2 = { action: 'SET_CARD_V2', body: { card: { type: 'aime', id: '0102', sak: 8, atqa: 1024, accessCode: '00112233445566778899' }, source: 'NFC' } }
  it('converts V2 cards for legacy clients', () => {
    expect(messageForClient(v2, { cardProtocol: 1, clientVersion: 'legacy' })).toEqual({ action: 'SET_CARD', body: { type: 'aime', value: '00112233445566778899', source: 'NFC' } })
  })
  it('keeps V2 cards for capable clients', () => {
    expect(messageForClient(v2, { cardProtocol: 2, clientVersion: '1.1.0' })).toBe(v2)
  })

  it('projects real transit card types only for legacy clients', () => {
    expect(messageForClient({
      action: 'SET_CARD_V2',
      body: { card: { type: 'tunion', id: '01020304', sak: 32, atqa: 1024, cardNumber: '01234567890123456789' } },
    }, { cardProtocol: 1, clientVersion: 'legacy' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'aime', value: '01234567890123456789' },
    })

    expect(messageForClient({
      action: 'SET_CARD_V2',
      body: { card: { type: 'suica', id: '01120212e423ef1d', pmm: '00f1000000014300', systemCode: [3] } },
    }, { cardProtocol: 1, clientVersion: 'legacy' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'felica', value: '01120212e423ef1d' },
    })
  })

  it('keeps the Banapass domain name in V2 and maps it at the V1 boundary', () => {
    const banapass = {
      action: 'SET_CARD_V2',
      body: { card: { type: 'banapass', id: '01020304', sak: 8, atqa: 1024, block1: '00'.repeat(16), block2: null } },
    }

    expect(messageForClient(banapass, { cardProtocol: 2, clientVersion: '1.1.0' })).toBe(banapass)
    expect(messageForClient(banapass, { cardProtocol: 1, clientVersion: 'legacy' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'mifare', value: '00'.repeat(16) },
    })
  })
})
