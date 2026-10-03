import { describe, expect, it } from 'vitest'
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  getTargetRole,
  messageForClient,
  normalizeStateMessage,
  prepareMessageForClient,
  routeWebSocketMessage,
  type ClientCapabilities,
} from './relay'

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

describe('capabilitiesFromRequest', () => {
  it('parses controller role from query param', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1?role=controller')
    expect(capabilitiesFromRequest(req)).toEqual({
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'controller',
    })
  })

  it('parses controller role case-insensitively', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1?role=CONTROLLER')
    expect(capabilitiesFromRequest(req).role).toBe('controller')
  })

  it('parses agent role explicitly', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1?role=agent&card_protocol=2&client_version=0.1.0')
    expect(capabilitiesFromRequest(req)).toEqual({
      cardProtocol: 2,
      clientVersion: '0.1.0',
      role: 'agent',
    })
  })

  it('defaults to agent role when role is omitted (legacy AimeIO)', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1?card_protocol=2&client_version=0.1.0')
    expect(capabilitiesFromRequest(req)).toEqual({
      cardProtocol: 2,
      clientVersion: '0.1.0',
      role: 'agent',
    })
  })

  it('defaults to agent role with legacy fallback for empty query', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1')
    expect(capabilitiesFromRequest(req)).toEqual({
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'agent',
    })
  })

  it('defaults unknown roles to agent', () => {
    const req = new Request('https://aime-ws.neri.moe/room-1?role=viewer')
    expect(capabilitiesFromRequest(req).role).toBe('agent')
  })
})

describe('capabilitiesForAttachment', () => {
  it('deserializes attachment for controller', () => {
    const caps = capabilitiesForAttachment({
      cardProtocol: 2,
      clientVersion: '2.0.0',
      role: 'controller',
    })
    expect(caps).toEqual({
      cardProtocol: 2,
      clientVersion: '2.0.0',
      role: 'controller',
    })
  })

  it('deserializes attachment for agent with defaults', () => {
    const caps = capabilitiesForAttachment({})
    expect(caps).toEqual({
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'agent',
    })
  })

  it('handles null or non-object attachment safely', () => {
    expect(capabilitiesForAttachment(null)).toEqual({
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'agent',
    })
    expect(capabilitiesForAttachment('invalid')).toEqual({
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'agent',
    })
  })
})

describe('getTargetRole', () => {
  it('maps controller to agent', () => {
    expect(getTargetRole('controller')).toBe('agent')
  })

  it('maps agent to controller', () => {
    expect(getTargetRole('agent')).toBe('controller')
  })
})

describe('prepareMessageForClient', () => {
  const v2Json = JSON.stringify({
    action: 'SET_CARD_V2',
    body: {
      card: {
        type: 'aime',
        id: '0102',
        sak: 8,
        atqa: 1024,
        accessCode: '00112233445566778899',
      },
      source: 'NFC',
    },
  })

  it('down-converts SET_CARD_V2 for protocol 1 clients', () => {
    const result = prepareMessageForClient(v2Json, {
      cardProtocol: 1,
      clientVersion: 'legacy',
      role: 'agent',
    })
    expect(JSON.parse(result as string)).toEqual({
      action: 'SET_CARD',
      body: {
        type: 'aime',
        value: '00112233445566778899',
        source: 'NFC',
      },
    })
  })

  it('leaves SET_CARD_V2 intact for protocol 2 clients', () => {
    const result = prepareMessageForClient(v2Json, {
      cardProtocol: 2,
      clientVersion: '1.1.0',
      role: 'agent',
    })
    expect(result).toBe(v2Json)
  })

  it('leaves E2EE_V1 payloads untouched', () => {
    const e2eeJson = JSON.stringify({
      action: 'E2EE_V1',
      body: {
        salt: 'somesalt',
        nonce: 'somenonce',
        message_id: 'uuid-1',
        expires_at: 1800000000000,
        ciphertext: 'opaque_ciphertext',
      },
    })
    const result = prepareMessageForClient(e2eeJson, {
      cardProtocol: 2,
      clientVersion: '1.0.0',
      role: 'controller',
    })
    expect(result).toBe(e2eeJson)
  })

  it('returns non-JSON strings unchanged', () => {
    const raw = 'PING'
    expect(prepareMessageForClient(raw, {
      cardProtocol: 2,
      clientVersion: '1.0.0',
      role: 'agent',
    })).toBe(raw)
  })

  it('returns ArrayBuffer unchanged', () => {
    const buffer = new ArrayBuffer(8)
    expect(prepareMessageForClient(buffer, {
      cardProtocol: 2,
      clientVersion: '1.0.0',
      role: 'agent',
    })).toBe(buffer)
  })
})

describe('routeWebSocketMessage', () => {
  const controllerSocket = { id: 'controller-1' }
  const controllerCaps: ClientCapabilities = {
    cardProtocol: 2,
    clientVersion: '2.0.0',
    role: 'controller',
  }

  const agentSocket = { id: 'agent-1' }
  const agentCaps: ClientCapabilities = {
    cardProtocol: 2,
    clientVersion: '1.0.0',
    role: 'agent',
  }

  const legacyAgentSocket = { id: 'legacy-agent-1' }
  const legacyAgentCaps: ClientCapabilities = {
    cardProtocol: 1,
    clientVersion: 'legacy',
    role: 'agent',
  }

  const secondControllerSocket = { id: 'controller-2' }
  const secondControllerCaps: ClientCapabilities = {
    cardProtocol: 2,
    clientVersion: '2.0.0',
    role: 'controller',
  }

  const allSockets = [
    { socket: controllerSocket, capabilities: controllerCaps },
    { socket: secondControllerSocket, capabilities: secondControllerCaps },
    { socket: agentSocket, capabilities: agentCaps },
    { socket: legacyAgentSocket, capabilities: legacyAgentCaps },
  ]

  it('routes message from controller to all agents (and not controllers or self)', () => {
    const e2eeReq = JSON.stringify({
      action: 'E2EE_V1',
      body: { ciphertext: 'rpc_req_payload' },
    })

    const routes = routeWebSocketMessage(
      controllerCaps,
      e2eeReq,
      allSockets,
      controllerSocket
    )

    expect(routes).toHaveLength(2)
    expect(routes.map(r => r.socket.id)).toEqual(['agent-1', 'legacy-agent-1'])
    expect(routes[0].payload).toBe(e2eeReq)
    expect(routes[1].payload).toBe(e2eeReq)
  })

  it('routes message from agent to all controllers (and not agents or self)', () => {
    const e2eeResp = JSON.stringify({
      action: 'E2EE_V1',
      body: { ciphertext: 'rpc_resp_payload' },
    })

    const routes = routeWebSocketMessage(
      agentCaps,
      e2eeResp,
      allSockets,
      agentSocket
    )

    expect(routes).toHaveLength(2)
    expect(routes.map(r => r.socket.id)).toEqual(['controller-1', 'controller-2'])
    expect(routes[0].payload).toBe(e2eeResp)
    expect(routes[1].payload).toBe(e2eeResp)
  })

  it.each(['event.cardStateChanged', 'event.cardConsumed', 'event.ledSet'])(
    'forwards IO notification %s unchanged to controllers only', method => {
      const notification = JSON.stringify({
        jsonrpc: '2.0', method,
        params: { unit_no: 0, sequence: 1, session_id: 'io-test', timestamp_ms: 1234 },
      })
      const routes = routeWebSocketMessage(agentCaps, notification, allSockets, agentSocket)
      expect(routes.map(route => route.socket.id)).toEqual(['controller-1', 'controller-2'])
      expect(routes.every(route => route.payload === notification)).toBe(true)
    }
  )

  it('applies protocol translation when routing SET_CARD_V2 to legacy agents', () => {
    const v2CardMsg = JSON.stringify({
      action: 'SET_CARD_V2',
      body: {
        card: {
          type: 'aime',
          id: '0102',
          sak: 8,
          atqa: 1024,
          accessCode: '11223344556677889900',
        },
      },
    })

    const routes = routeWebSocketMessage(
      controllerCaps,
      v2CardMsg,
      allSockets,
      controllerSocket
    )

    expect(routes).toHaveLength(2)
    // Agent 1 (protocol 2) gets original V2
    expect(routes.find(r => r.socket.id === 'agent-1')?.payload).toBe(v2CardMsg)
    // Legacy Agent (protocol 1) gets converted V1
    const legacyPayload = routes.find(r => r.socket.id === 'legacy-agent-1')?.payload
    expect(JSON.parse(legacyPayload as string)).toEqual({
      action: 'SET_CARD',
      body: {
        type: 'aime',
        value: '11223344556677889900',
      },
    })
  })

  it('returns empty array when no sockets of target role exist', () => {
    const controllerOnly = [
      { socket: controllerSocket, capabilities: controllerCaps },
    ]

    const routes = routeWebSocketMessage(
      controllerCaps,
      'test-message',
      controllerOnly,
      controllerSocket
    )

    expect(routes).toEqual([])
  })
})

describe('messageForClient', () => {
  const v2 = {
    action: 'SET_CARD_V2',
    body: {
      card: {
        type: 'aime',
        id: '0102',
        sak: 8,
        atqa: 1024,
        accessCode: '00112233445566778899',
      },
      source: 'NFC',
    },
  }
  it('converts V2 cards for legacy clients', () => {
    expect(messageForClient(v2, { cardProtocol: 1, clientVersion: 'legacy', role: 'agent' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'aime', value: '00112233445566778899', source: 'NFC' },
    })
  })
  it('keeps V2 cards for capable clients', () => {
    expect(messageForClient(v2, { cardProtocol: 2, clientVersion: '1.1.0', role: 'agent' })).toBe(v2)
  })

  it('projects real transit card types only for legacy clients', () => {
    expect(messageForClient({
      action: 'SET_CARD_V2',
      body: { card: { type: 'tunion', id: '01020304', sak: 32, atqa: 1024, cardNumber: '01234567890123456789' } },
    }, { cardProtocol: 1, clientVersion: 'legacy', role: 'agent' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'aime', value: '01234567890123456789' },
    })

    expect(messageForClient({
      action: 'SET_CARD_V2',
      body: { card: { type: 'suica', id: '01120212e423ef1d', pmm: '00f1000000014300', systemCode: [3] } },
    }, { cardProtocol: 1, clientVersion: 'legacy', role: 'agent' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'felica', value: '01120212e423ef1d' },
    })
  })

  it('keeps the Banapass domain name in V2 and maps it at the V1 boundary', () => {
    const banapass = {
      action: 'SET_CARD_V2',
      body: { card: { type: 'banapass', id: '01020304', sak: 8, atqa: 1024, block1: '00'.repeat(16), block2: null } },
    }

    expect(messageForClient(banapass, { cardProtocol: 2, clientVersion: '1.1.0', role: 'agent' })).toBe(banapass)
    expect(messageForClient(banapass, { cardProtocol: 1, clientVersion: 'legacy', role: 'agent' })).toEqual({
      action: 'SET_CARD',
      body: { type: 'mifare', value: '00'.repeat(16) },
    })
  })
})
