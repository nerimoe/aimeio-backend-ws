# aimeio-backend-ws

Cloudflare Workers + Hono + Durable Objects 的 AimeIO WebSocket 中继服务。

## 开发环境

工具版本由 `.nvmrc` 和 `.bun-version` 固定：Node.js 24.19.0、Bun 1.4.2。
Wrangler、TypeScript、Vitest 和 Hono 使用仓库已有的 `bun.lock`，安装时不更新依赖版本。

当前云工作区的 `/workspace/aimeio-backend-ws` 已安装工具与依赖。其他 Linux/macOS
环境可先安装 Node.js（使用 nvm 时运行 `nvm install && nvm use`），再安装 Bun：

```bash
npm install --global --prefix "$HOME/.local" bun@1.4.2
export PATH="$HOME/.local/bin:$PATH"
```

然后在仓库根目录运行：

```bash
bun install --frozen-lockfile
bun run dev
```

本地地址是 `http://127.0.0.1:8787`，WebSocket 地址是
`ws://127.0.0.1:8787/<id>`。Wrangler 使用本地 Workers 运行时和本地 Durable Objects，
开发、构建和测试不需要 Cloudflare 登录、API token 或额外数据库。开发状态保存在
已忽略的 `.wrangler/` 中，按 Ctrl+C 停止服务。

## 构建和检查

```bash
bun run typecheck    # TypeScript 类型检查
bun run test         # Vitest 单元测试
bun run test:watch   # 开发时持续运行单元测试
bun run build        # 本地打包到 dist/，不会部署
bun run test:smoke   # 自动启动本地 Worker 并验证 HTTP/WebSocket
bun run check        # 依次执行类型检查、单元测试、打包和冒烟测试
```

冒烟测试使用自动分配的本地端口和临时状态目录，不占用开发服务的 8787 端口。
测试覆盖未连接 Agent 时的响应、能力查询、卡片 POST、事件广播、状态重放、
Agent/Controller 双向 WebSocket 转发和 DELETE 清卡；完成后关闭测试服务并清理状态。

GitHub Actions 的 `Development Checks` 工作流使用同样的工具版本及
`bun install --frozen-lockfile`，在 push/PR 时运行 `bun run check`。

修改 `wrangler.jsonc` 中的 bindings 或 compatibility 配置后，重新生成类型：

```bash
bun run cf-typegen
bun run typecheck
```

## 本地接口检查

没有 Agent 连接时，下面的请求返回 404，这是正常行为：

```bash
curl http://127.0.0.1:8787/dev/capabilities
```

先让 AimeIO Agent 连接 `ws://127.0.0.1:8787/dev?role=agent`，再向相同 ID 上报卡片：

```bash
curl -X POST http://127.0.0.1:8787/dev \
  -H 'Content-Type: application/json' \
  -d '{"type":"aime","value":"01234567890123456789"}'
```

`<id>` 是中继通道名，HTTP 请求与 WebSocket 连接必须使用同一个 ID。

## 部署

部署需要具有 Workers/Durable Objects 权限的 Cloudflare 账号：

```bash
bun x wrangler login
bun run deploy
```

本次环境配置仅完成本地构建与测试，没有执行部署。

## 接口

Remote relay endpoints:

- `GET /<id>` upgrades to the state WebSocket and replays the last state message.
- `GET /<id>/capabilities` returns the connected AimeIO agent capabilities so HTTP controllers can choose compatible Banapass fields.
- `POST /<id>` stores and broadcasts a state message. A body with `action` is forwarded unchanged; a legacy Card body is wrapped as `SET_CARD`.
- `POST /<id>/event` broadcasts an event without storing it or replaying it to later connections.
- `DELETE /<id>` clears the stored state and broadcasts `CLEAR_CARD`.

## IO 回报事件

IO 以 `role=agent` 连接 Relay，控制端使用同一通道的 `role=controller`。IO 可以通过
同一 WebSocket 发送 JSON-RPC notification：`event.cardStateChanged`（轮询卡片状态变化）、
`event.cardConsumed`（成功向游戏交付卡片）和 `event.ledSet`（游戏下发灯光）。
它们包含 `session_id`、`sequence`、`timestamp_ms`、`interface`、`unit_no`，以及对应的
卡片/取卡接口/原始 RGB 字段。Relay 原样转发到 Controller，不包装成卡片命令、不发回
其他 Agent，也不为后来连接的 Controller 保存或重放这些事件。密码模式下消息外层为
`E2EE_V1`，由 Controller 解密，Relay 不需要知道密码。

普通 `bun run test:smoke` 也验证三类通知的回程。若已构建 hinata-aimeio-rs 的实际
Windows DLL 和 `tools/windows_relay_smoke.c`，可以额外验证 DLL 的真实往返：

```bash
AIMEIO_DLL_FIXTURE=/absolute/path/windows_relay_smoke.exe \
AIMEIO_DLL_PATH=/absolute/path/hinata_aimeio_rs.dll \
  bun run test:smoke
```

Linux 使用 Wine 和 Xvfb；Windows 直接运行 EXE。测试在临时目录生成只连接本地 Relay
的 INI，并关闭自动更新；它从 Controller 下发测试卡，验证 IO 轮询、游戏取卡、重复读取
去重、LED 命令回报和清卡回报。无需真实读卡器，不调用生产上传端点。

The Worker is a blind relay. It does not decrypt payloads or maintain an action allowlist. Password-based `E2EE_V1` messages are optional; clients without a password can continue using the legacy Card POST format.

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
