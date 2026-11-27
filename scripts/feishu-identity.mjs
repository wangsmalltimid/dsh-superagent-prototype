/** Shared host/worker identity rules. No API call or authentication is performed here. */
export function unsupportedUserIdentity(error) {
  return error?.type === 'validation' && error.subtype === 'invalid_argument'
    && Array.isArray(error.params) && error.params.some(param => param?.name === '--as')
    && error.message === '--as user is not supported, this command only supports: bot'
}

function commandArguments(args) {
  let index = 0
  while (args[index] === '--profile' || args[index]?.startsWith('--profile=')) {
    index += args[index] === '--profile' ? 2 : 1
  }
  return args.slice(index)
}

export function botOperation(input) {
  const args = commandArguments(input)
  if (args[0] === 'event') return true
  if (args[0] === 'im') {
    return ['+messages-send', '+messages-reply', '+threads-forward'].includes(args[1])
      || (args[1] === 'messages' && ['forward', 'merge_forward', 'patch', 'delete'].includes(args[2]))
      || (args[1] === 'threads' && args[2] === 'forward')
  }
  return args[0] === 'api' && args[1] !== 'GET'
    && /^\/open-apis\/im\/v\d+\/(?:messages|threads)(?:\/|$)/.test((args[2] ?? '').split('?')[0])
}

export function routedArguments(input) {
  const args = []
  let requested
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]
    if (arg === '--') { args.push(...input.slice(index)); break }
    if (arg === '--as' || arg.startsWith('--as=')) {
      requested = arg === '--as' ? input[++index] : arg.slice(5)
      if (!['user', 'bot', 'auto'].includes(requested)) throw new Error('--as must be user, bot, or auto')
    } else args.push(arg)
  }
  // These control commands do not take --as. Keep their CLI's normal behavior.
  const command = commandArguments(args)[0]
  const control = command === undefined || ['auth', 'config', 'profile', 'schema', 'skills', 'whoami', 'version', 'doctor', 'update', 'help', '--help', '-h', '--version', '-v'].includes(command)
  if (control) return { args: [...input], identity: undefined }
  return { args, identity: botOperation(args) || requested === 'bot' ? 'bot' : 'user' }
}
