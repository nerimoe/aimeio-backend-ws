import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DurableObject } from 'cloudflare:workers'
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  messageForClient,
  normalizeStateMessage,
  routeWebSocketMessage,
  type ClientCapabilities,
  type ClientRole,
  type RelayMessage,
} from './relay'

// ==========================================
// 1. 类型定义
// ==========================================
type Bindings = {
  CARD_DO: DurableObjectNamespace<CardDO>
}

// ==========================================
// 2. 外部 Worker (入口路由)
// ==========================================
const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

app.all('/:id/*', async (c) => {
  const id = c.env.CARD_DO.idFromName(c.req.param('id'))
  const stub = c.env.CARD_DO.get(id)
  return stub.fetch(c.req.raw)
})

export default app

// ==========================================
// 3. Durable Object 类 (核心逻辑)
// ==========================================
export class CardDO extends DurableObject {
  // 定义内部的 Hono 实例
  app: Hono = new Hono()
  currentStateMessage: RelayMessage | null = null
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)

    // ----------------------------------------
    // 在构造函数中定义内部路由
    // 注意：这里的路径必须匹配外部传入的完整路径
    // 外部传入的是 /:id/ws，所以这里用 /:actionId/ws 来匹配
    // ----------------------------------------

    // A. WebSocket 连接路由
    this.app.get('/:actionId', async (c) => {
      if (c.req.header('Upgrade') !== 'websocket') {
        return c.text('Expected Upgrade: websocket', 426)
      }

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      const capabilities = capabilitiesFromRequest(c.req.raw)
      // 接受连接 (Hibernation API)
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment(capabilities)

      // 新连接建立时，如果是 agent，只重发状态通道的最后一条消息。
      if (this.currentStateMessage && capabilities.role === 'agent') {
        try {
          server.send(JSON.stringify(messageForClient(this.currentStateMessage, capabilities)))
        } catch (e) {
          // 忽略
        }
      }

      return new Response(null, { status: 101, webSocket: client })
    })

    // Expose the capabilities of the currently connected AimeIO agents so
    // HTTP controllers can choose compatible Banapass card fields.
    this.app.get('/:actionId/capabilities', async (c) => {
      const agents = this.ctx.getWebSockets()
        .map(capabilitiesForSocket)
        .filter(capabilities => capabilities.role === 'agent')
        .map(({ cardProtocol, clientVersion }) => ({ cardProtocol, clientVersion }))

      if (agents.length === 0) {
        return c.json({ error: 'No active client connected' }, 404)
      }

      return c.json({ agents }, 200)
    })

    // B. 事件写入路由：只向 Agent 广播，不保存、不重发。
    this.app.post('/:actionId/event', async (c) => {
      const agentWebsockets = this.ctx.getWebSockets().filter(ws => capabilitiesForSocket(ws).role === 'agent')
      if (agentWebsockets.length === 0) {
        return c.text('No active client connected', 404)
      }

      const message = await c.req.json<unknown>()
      this.broadcast(message, false, 'agent')

      return c.text('success', 200)
    })

    // C. 状态写入路由
    this.app.post('/:actionId', async (c) => {
      const agentWebsockets = this.ctx.getWebSockets().filter(ws => capabilitiesForSocket(ws).role === 'agent')
      if (agentWebsockets.length === 0) {
        return c.text('No active client connected', 404)
      }

      const payload = await c.req.json<unknown>()
      const message = normalizeStateMessage(payload)

      this.currentStateMessage = message
      this.broadcast(message, true, 'agent')

      return c.text('success', 200)
    })

    this.app.delete('/:actionId', async (c) => {
      this.currentStateMessage = null
      this.broadcast({ action: 'CLEAR_CARD' }, true, 'agent')
      return c.text('success', 200)
    })

    // D. 404 处理 (可选)
    this.app.get('*', (c) => c.text('DO Not Found', 404))
  }

  // === 辅助方法：广播 ===
  async broadcast(data: unknown, state = true, targetRole?: ClientRole) {
    const websockets = this.ctx.getWebSockets()
    const targets = targetRole
      ? websockets.filter(ws => capabilitiesForSocket(ws).role === targetRole)
      : websockets

    if (targets.length > 0) {
      const normalized = state ? normalizeStateMessage(data) : data as RelayMessage
      targets.forEach(ws => {
        try {
          ws.send(JSON.stringify(messageForClient(normalized, capabilitiesForSocket(ws))))
        } catch (e) {
          // 忽略发送失败
        }
      })
    }
  }

  // ==========================================
  // DO 标准接口
  // ==========================================

  // 1. Fetch 入口：直接把请求转交给内部 Hono
  async fetch(request: Request) {
    return this.app.fetch(request)
  }

  // 2. WebSocket 事件 (Hono 不处理这里，必须写在类方法里)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const senderCaps = capabilitiesForSocket(ws)
    const websockets = this.ctx.getWebSockets()
    const socketItems = websockets.map(socket => ({
      socket,
      capabilities: capabilitiesForSocket(socket),
    }))

    const routed = routeWebSocketMessage(senderCaps, message, socketItems, ws)
    for (const { socket, payload } of routed) {
      try {
        socket.send(payload)
      } catch (e) {
        // 忽略发送失败
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // Hibernation sockets need the server to finish the closing handshake.
    // 1005/1006/1015 are reserved and cannot be sent in a close frame.
    const responseCode = [1005, 1006, 1015].includes(code) ? 1000 : code
    ws.close(responseCode, reason)
  }
}

function capabilitiesForSocket(ws: WebSocket): ClientCapabilities {
  return capabilitiesForAttachment(ws.deserializeAttachment())
}
