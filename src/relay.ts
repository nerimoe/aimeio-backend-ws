export type RelayMessage = Record<string, unknown> & {
  action: string
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
