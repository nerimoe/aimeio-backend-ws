```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Remote relay endpoints:

- `GET /<id>` upgrades to the state WebSocket and replays the last state message.
- `POST /<id>` stores and broadcasts a state message. A body with `action` is forwarded unchanged; a legacy Card body is wrapped as `SET_CARD`.
- `POST /<id>/event` broadcasts an event without storing it or replaying it to later connections.
- `DELETE /<id>` clears the stored state and broadcasts `CLEAR_CARD`.

The Worker is a blind relay. It does not decrypt payloads or maintain an action allowlist. Password-based `E2EE_V1` messages are optional; clients without a password can continue using the legacy Card POST format.

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
