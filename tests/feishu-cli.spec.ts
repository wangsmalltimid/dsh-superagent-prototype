import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { writeEnvironment, workerBin } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-routing-')); directories.push(dir)
  const bot = join(dir, 'bot'), user = join(dir, 'user'), log = join(dir, 'calls')
  for (const [role, file] of [['bot', bot], ['user', user]] as const) {
    await writeFile(file, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(role + '\n')});
const failure = process.env.FEISHU_ROUTING_FAILURE;
if (${JSON.stringify(role)} === 'user' && failure) {
  const error = failure === 'unsupported'
    ? {type:'validation',subtype:'invalid_argument',params:[{name:'--as'}],message:'--as user is not supported, this command only supports: bot'}
    : {type:'authentication',subtype:'token_invalid',code:99991668,message:'token invalid'};
  process.stderr.write(JSON.stringify({ok:false,error})); process.exitCode = 3;
} else process.stdout.write(JSON.stringify({role:${JSON.stringify(role)},args:process.argv.slice(2)}));
`, { mode: 0o755 })
  }
  const deployment = testDeployment({ stateDir: dir, feishu: { ...testDeployment().feishu!, cli: bot } })
  await writeEnvironment(deployment, [], user)
  const shim = join(workerBin(dir), 'lark-cli')
  const run = (args: string[], failure?: string) => exec(shim, args, {
    env: { PATH: `${workerBin(dir)}:/usr/bin:/bin`, ...(failure ? { FEISHU_ROUTING_FAILURE: failure } : {}) }, timeout: 5000,
  })
  return { dir, shim, user, log, run }
}
it('routes the real generated worker shim to user for reads and bot for messages and events', async () => {
  const { run } = await fixture()
  for (const args of [['docs', '+fetch', '--doc', 'example'], ['im', '+messages-mget', '--message-ids', 'om_example']]) {
    expect(JSON.parse((await run(args)).stdout)).toEqual({ role: 'user', args: [...args, '--as', 'user'] })
  }
  for (const args of [
    ['im', '+messages-send', '--text', 'literal `value` $(echo x)', '--as', 'user'],
    ['--profile', 'example', 'im', '+messages-reply', '--as=user'],
    ['api', 'POST', '/open-apis/im/v1/messages', '--as=user'],
    ['im', 'messages', 'forward', '--as', 'user'], ['im', 'threads', 'forward', '--as=user'],
    ['api', 'POST', '/open-apis/im/v1/threads/omt_example/forward', '--as=user'],
    ['event', 'consume', 'im.message.receive_v1'],
  ]) {
    const result = JSON.parse((await run(args)).stdout)
    expect(result.role).toBe('bot')
    expect(result.args.slice(-2)).toEqual(['--as', 'bot'])
    expect(result.args).not.toContain('--as=user')
  }
})
it('retries an unsupported user interface once without exposing its discarded validation error', async () => {
  const { run, log } = await fixture()
  const result = await run(['im', '+chat-list'], 'unsupported')
  expect(JSON.parse(result.stdout).role).toBe('bot')
  expect(result.stderr).toBe('')
  expect(await readFile(log, 'utf8')).toBe('user\nbot\n')
})
it('preserves authorization failure and exit status instead of falling back', async () => {
  const { run, log } = await fixture()
  await expect(run(['im', '+chat-list'], 'token')).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('token invalid') })
  expect(await readFile(log, 'utf8')).toBe('user\n')
})
it('preserves explicit bot reads and does not inject --as into CLI control commands', async () => {
  const { run } = await fixture()
  expect(JSON.parse((await run(['im', '+chat-list', '--as=bot'])).stdout).role).toBe('bot')
  expect(JSON.parse((await run(['auth', 'status'])).stdout)).toEqual({ role: 'user', args: ['auth', 'status'] })
  expect(JSON.parse((await run(['schema', 'im.messages.get'])).stdout).args).toEqual(['schema', 'im.messages.get'])
})
it('rejects a recursive worker CLI configuration before replacing shims', async () => {
  const { dir, shim } = await fixture()
  await expect(writeEnvironment(testDeployment({ stateDir: dir }), [], resolve(shim))).rejects.toThrow('not the worker shim')
})
