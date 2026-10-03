import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const stateDir = await mkdtemp(join(tmpdir(), 'aimeio-ws-smoke-'))
const portAllocator = createServer()
portAllocator.listen(0, '127.0.0.1')
await once(portAllocator, 'listening')
const port = portAllocator.address().port
await new Promise((resolve, reject) => portAllocator.close(error => error ? reject(error) : resolve()))

const worker = spawn(process.execPath, [
  join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--local', '--ip', '127.0.0.1', '--port', String(port),
  '--inspector-port', '0', '--persist-to', stateDir,
  '--show-interactive-dev-session=false',
], {
  cwd: root,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let spawnError
worker.on('error', error => { spawnError = error })
worker.stdout.on('data', data => { output = (output + data).slice(-16000) })
worker.stderr.on('data', data => { output = (output + data).slice(-16000) })
const sockets = []
let ioProcess
const httpUrl = `http://127.0.0.1:${port}/dev-smoke`
const wsUrl = `ws://127.0.0.1:${port}/dev-smoke`

function waitForEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`WebSocket ${event} timed out`)), 5000)
    const onEvent = value => finish(null, value)
    const onError = () => finish(new Error(`WebSocket ${event} failed`))
    function finish(error, value) {
      clearTimeout(timer)
      socket.removeEventListener(event, onEvent)
      socket.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    socket.addEventListener(event, onEvent, { once: true })
    socket.addEventListener('error', onError, { once: true })
  })
}

function socketAt(query) {
  const socket = new WebSocket(`${wsUrl}?${query}`)
  sockets.push(socket)
  return socket
}

async function expectMessage(socket, trigger, expected) {
  const message = waitForEvent(socket, 'message')
  // Always observe the message promise even if the HTTP request fails first.
  const [event] = await Promise.all([message, trigger()])
  assert.deepEqual(JSON.parse(event.data), expected)
}

try {
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error('Wrangler exited before the local Worker was ready')
    }
    try {
      const response = await fetch(httpUrl, { signal: AbortSignal.timeout(1000) })
      if (response.status === 426) { ready = true; break }
    } catch { /* Worker is still starting. */ }
    await delay(200)
  }
  assert.ok(ready, 'Local Worker must return 426 for an HTTP request without a WebSocket upgrade')
  assert.equal((await fetch(`${httpUrl}/capabilities`)).status, 404)
  assert.equal((await fetch(httpUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status, 404)

  const agent = socketAt('role=agent&card_protocol=2&client_version=dev-smoke')
  await waitForEvent(agent, 'open')
  const controller = socketAt('role=controller')
  await waitForEvent(controller, 'open')
  assert.deepEqual(await (await fetch(`${httpUrl}/capabilities`)).json(), {
    agents: [{ cardProtocol: 2, clientVersion: 'dev-smoke' }],
  })

  const card = { type: 'aime', value: '01234567890123456789' }
  const state = { action: 'SET_CARD', body: card }
  await expectMessage(agent, async () => {
    const response = await fetch(httpUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card),
    })
    assert.equal(response.status, 200)
  }, state)

  const event = { action: 'DEV_SMOKE_EVENT', body: { key: 13 } }
  await expectMessage(agent, async () => {
    const response = await fetch(`${httpUrl}/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    })
    assert.equal(response.status, 200)
  }, event)

  // New agents must replay the state, rather than the event sent after it.
  const replayAgent = socketAt('role=agent')
  await expectMessage(replayAgent, () => waitForEvent(replayAgent, 'open'), state)

  const command = { action: 'DEV_SMOKE_COMMAND' }
  await expectMessage(agent, async () => controller.send(JSON.stringify(command)), command)
  const reply = { action: 'DEV_SMOKE_REPLY' }
  await expectMessage(controller, async () => agent.send(JSON.stringify(reply)), reply)
  // IO notifications are events, forwarded agent -> controller without wrapping.
  for (const method of ['event.cardStateChanged', 'event.cardConsumed', 'event.ledSet']) {
    const notification = {
      jsonrpc: '2.0', method,
      params: { unit_no: 0, sequence: 1, session_id: 'smoke-agent', timestamp_ms: Date.now() },
    }
    await expectMessage(controller, async () => agent.send(JSON.stringify(notification)), notification)
  }
  await expectMessage(agent, async () => {
    assert.equal((await fetch(httpUrl, { method: 'DELETE' })).status, 200)
  }, { action: 'CLEAR_CARD' })
  if (process.env.AIMEIO_DLL_FIXTURE && process.env.AIMEIO_DLL_PATH) {
    // Optional integration mode exercises the actual Windows IO DLL, rather than
    // a simulated agent. Both paths must point to builds from hinata-aimeio-rs.
    await Promise.all(sockets.map(socket => {
      if (socket.readyState === WebSocket.CLOSED) return
      const closed = waitForEvent(socket, 'close')
      socket.close()
      return closed
    }))
    const ioDir = join(stateDir, 'io')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(ioDir)
    await writeFile(join(ioDir, 'segatools.ini'), `[aimeio]\nserverUrl=${wsUrl}\nautoUpdate=0\nlogLevel=warn\n`)
    const monitor = socketAt('role=controller')
    await waitForEvent(monitor, 'open')
    const events = []
    let helloSeen = false
    monitor.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.action === 'CLIENT_HELLO') {
        helloSeen = message.body.event_protocol === 1
        monitor.send(JSON.stringify({
          action: 'SET_CARD',
          body: { ...card, source: 'relay-e2e', duration: 60000, disposable: false },
        }))
      } else if (message.method?.startsWith('event.')) {
        events.push(message)
        if (message.method === 'event.ledSet') monitor.send(JSON.stringify({ action: 'CLEAR_CARD' }))
      }
    })
    const command = process.platform === 'win32' ? process.env.AIMEIO_DLL_FIXTURE : 'xvfb-run'
    const args = process.platform === 'win32'
      ? [process.env.AIMEIO_DLL_PATH]
      : ['-a', process.env.WINE_COMMAND ?? '/usr/lib/wine/wine64', process.env.AIMEIO_DLL_FIXTURE, process.env.AIMEIO_DLL_PATH]
    ioProcess = spawn(command, args, { cwd: ioDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let ioOutput = ''
    ioProcess.stdout.on('data', data => { ioOutput += data })
    ioProcess.stderr.on('data', data => { ioOutput += data })
    let timer
    try {
      const [code] = await Promise.race([
        once(ioProcess, 'exit'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IO DLL relay test timed out')), 45000) }),
      ])
      assert.equal(code, 0, ioOutput)
      assert.ok(helloSeen, 'IO must advertise event_protocol=1')
      assert.deepEqual(events.map(event => event.method), [
        'event.cardStateChanged', 'event.cardConsumed', 'event.ledSet', 'event.cardStateChanged',
      ])
      assert.equal(events[0].params.backend, 'Remote')
      assert.equal(events[0].params.card.source, 'relay-e2e')
      assert.equal(events[0].params.card.card.accessCode, card.value)
      assert.equal(events[1].params.api, 'aime_io_nfc_get_aime_id')
      assert.equal(events[2].params.r, 17)
      assert.equal(events[2].params.g, 34)
      assert.equal(events[2].params.b, 51)
      assert.equal(events[3].params.card, null)
      assert.equal(events[3].params.previous_card.source, 'relay-e2e')
      for (let i = 1; i < events.length; i++) {
        assert.equal(events[i].params.session_id, events[0].params.session_id)
        assert.ok(events[i].params.sequence > events[i - 1].params.sequence)
      }
      console.log('Actual IO DLL -> Relay -> Controller card/state/LED round trip passed.')
    } finally { clearTimeout(timer) }
  }
  console.log('Local Worker smoke test passed: HTTP, Durable Objects, WebSocket relay, state replay, events, and clear.')
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (ioProcess && ioProcess.exitCode === null && ioProcess.signalCode === null) ioProcess.kill('SIGTERM')
  for (const socket of sockets) socket.close()
  if (worker.exitCode === null && worker.signalCode === null && !spawnError) {
    const exited = once(worker, 'exit')
    worker.kill('SIGTERM')
    let killTimer
    await Promise.race([
      exited,
      new Promise(resolve => {
        killTimer = setTimeout(() => { worker.kill('SIGKILL'); resolve() }, 5000)
      }),
    ])
    clearTimeout(killTimer)
  }
  await rm(stateDir, { recursive: true, force: true })
}
