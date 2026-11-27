#!/usr/bin/env node
/** Worker CLI router. Executable paths are supplied by the host-generated shim. */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { routedArguments, unsupportedUserIdentity } from './feishu-identity.mjs'

const [botCli, userCli, ...input] = process.argv.slice(2)
const stderrLimit = 64 * 1024

async function invoke(cli, args, holdError) {
  return new Promise(resolve => {
    const child = spawn(cli, args, { stdio: ['inherit', 'pipe', 'pipe'] })
    let outputBytes = 0, errorBytes = 0, buffered = []
    const flush = () => { for (const chunk of buffered) process.stderr.write(chunk); buffered = [] }
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const forward = signal => child.kill(signal)
    const listeners = signals.map(signal => { const listener = () => forward(signal); process.on(signal, listener); return listener })
    child.stdout.on('data', chunk => { outputBytes += chunk.length })
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length
      if (holdError && errorBytes <= stderrLimit) buffered.push(chunk)
      else { flush(); holdError = false; process.stderr.write(chunk) }
    })
    child.on('error', () => { process.stderr.write('The configured Feishu CLI could not start.\n') })
    child.on('close', (code, signal) => {
      signals.forEach((signal, index) => process.removeListener(signal, listeners[index]))
      let unsupported = false
      if (holdError && outputBytes === 0 && code !== 0 && !signal) {
        try { const text = Buffer.concat(buffered).toString(); unsupported = unsupportedUserIdentity(JSON.parse(text.slice(text.indexOf('{'))).error) }
        catch { /* Unstructured failures never change identity. */ }
      }
      if (!unsupported) flush()
      resolve({ unsupported, code: code ?? (signal ? 128 + constants.signals[signal] : 1) })
    })
  })
}

try {
  if (!botCli || !userCli) throw new Error('Feishu CLI routing is not configured')
  const { args, identity } = routedArguments(input)
  const withIdentity = value => {
    const separator = args.indexOf('--')
    const index = separator < 0 ? args.length : separator
    return [...args.slice(0, index), '--as', value, ...args.slice(index)]
  }
  const result = await invoke(identity === 'bot' ? botCli : userCli, identity ? withIdentity(identity) : args, identity === 'user')
  if (result.unsupported) process.exitCode = (await invoke(botCli, withIdentity('bot'), false)).code
  else process.exitCode = result.code
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Feishu CLI routing failed'}\n`)
  process.exitCode = 2
}
