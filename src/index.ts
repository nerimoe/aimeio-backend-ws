import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DurableObject } from 'cloudflare:workers'

// ==========================================
// 1. 类型定义
// ==========================================
type Bindings = {
  CARD_DO: DurableObjectNamespace<CardDO>
}

type Message = {
  action: "SET_CARD" | "CLEAR_CARD",
  body?: Card,
  comment?: string
}

type Card = {
  type: string,
  value: string,
  duration?: number,
  source?: string,
  disposable?: boolean
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

      // 接受连接 (Hibernation API)
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    })

    // B. 数据写入路由
    this.app.post('/:actionId', async (c) => {
      const card = await c.req.json<Card>()

      await this.ctx.storage.put('card', card)
      this.broadcast({ action: "SET_CARD", body: card })

      return c.text('success', 200)
    })

    this.app.delete('/:actionId', async (c) => {
      await this.ctx.storage.delete('card')
      this.broadcast({ action: "CLEAR_CARD" })
      return c.text("success", 200)
    })



    // C. 404 处理 (可选)
    this.app.get('*', (c) => c.text('DO Not Found', 404))
  }



  // === 辅助方法：广播 ===
  async broadcast(data: Message) {
    const websockets = this.ctx.getWebSockets()
    if (websockets.length > 0) {
      const message = JSON.stringify(data)
      websockets.forEach(ws => {
        try {
          ws.send(message)
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
    // 处理客户端发来的消息 (如果有)
    // ws.send(`[Echo] ${message}`) 
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // 自动清理，一般不需要写代码
  }
}