export type RelayMessage = Record<string, unknown> & {
  action: string
}

export type ClientCapabilities = {
  cardProtocol: number
  clientVersion: string
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

function isActionMessage(value: unknown): value is RelayMessage {
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
  return {
    cardProtocol: Number.isFinite(cardProtocol) ? cardProtocol : 1,
    clientVersion: url.searchParams.get('client_version') ?? 'legacy',
  }
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
