export type RelayMessage = Record<string, unknown> & {
  action: string
}

export type ClientRole = 'agent' | 'controller'

export type ClientCapabilities = {
  cardProtocol: number
  clientVersion: string
  role: ClientRole
}

export function normalizeStateMessage(value: unknown): RelayMessage {
  if (isActionMessage(value)) {
    return value
  }

  return {
    action: 'SET_CARD',
    body: value,
  }
}

export function isActionMessage(value: unknown): value is RelayMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { action?: unknown }).action === 'string'
  )
}

export function capabilitiesFromRequest(request: Request): ClientCapabilities {
  const url = new URL(request.url)
  const cardProtocol = Number(url.searchParams.get('card_protocol') ?? '1')
  const roleParam = url.searchParams.get('role')?.trim().toLowerCase()
  const role: ClientRole = roleParam === 'controller' ? 'controller' : 'agent'
  return {
    cardProtocol: Number.isFinite(cardProtocol) ? cardProtocol : 1,
    clientVersion: url.searchParams.get('client_version') ?? 'legacy',
    role,
  }
}

export function capabilitiesForAttachment(attachment: unknown): ClientCapabilities {
  if (typeof attachment !== 'object' || attachment === null) {
    return { cardProtocol: 1, clientVersion: 'legacy', role: 'agent' }
  }
  const value = attachment as Partial<ClientCapabilities>
  return {
    cardProtocol: typeof value.cardProtocol === 'number' ? value.cardProtocol : 1,
    clientVersion: typeof value.clientVersion === 'string' ? value.clientVersion : 'legacy',
    role: value.role === 'controller' ? 'controller' : 'agent',
  }
}

export function getTargetRole(role: ClientRole): ClientRole {
  return role === 'controller' ? 'agent' : 'controller'
}

export function prepareMessageForClient(
  message: string | ArrayBuffer,
  capabilities: ClientCapabilities
): string | ArrayBuffer {
  if (typeof message !== 'string') {
    return message
  }
  try {
    const parsed = JSON.parse(message)
    if (isActionMessage(parsed)) {
      const transformed = messageForClient(parsed, capabilities)
      if (transformed !== parsed) {
        return JSON.stringify(transformed)
      }
    }
  } catch {
    // Not valid JSON, keep original string
  }
  return message
}

export function routeWebSocketMessage<T>(
  senderCaps: ClientCapabilities,
  message: string | ArrayBuffer,
  sockets: Array<{ socket: T; capabilities: ClientCapabilities }>,
  senderSocket?: T
): Array<{ socket: T; payload: string | ArrayBuffer }> {
  const targetRole = getTargetRole(senderCaps.role)
  const results: Array<{ socket: T; payload: string | ArrayBuffer }> = []

  for (const item of sockets) {
    if (senderSocket && item.socket === senderSocket) {
      continue
    }
    if (item.capabilities.role === targetRole) {
      const payload = prepareMessageForClient(message, item.capabilities)
      results.push({ socket: item.socket, payload })
    }
  }

  return results
}

export function messageForClient(message: RelayMessage, capabilities: ClientCapabilities): RelayMessage {
  if (message.action !== 'SET_CARD_V2' || capabilities.cardProtocol >= 2) return message
  const body = message.body
  if (!isRecord(body) || !isRecord(body.card) || typeof body.card.type !== 'string') return message
  const card = body.card
  let legacy: Record<string, unknown>
  switch (card.type) {
    case 'aime': legacy = { type: 'aime', value: card.accessCode }; break
    case 'aic': legacy = { type: 'aic', value: `${card.id}:${card.accessCode}` }; break
    case 'felica': legacy = { type: 'felica', value: card.id }; break
    case 'banapass': legacy = { type: 'mifare', value: `${card.block1}${typeof card.block2 === 'string' ? card.block2 : ''}` }; break
    case 'tunion': legacy = { type: 'aime', value: card.cardNumber }; break
    case 'suica': legacy = { type: 'felica', value: card.id }; break
    default: return message
  }
  for (const key of ['source', 'duration', 'disposable']) {
    if (key in body) legacy[key] = body[key]
  }
  return { action: 'SET_CARD', body: legacy }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

