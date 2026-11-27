export function unsupportedUserIdentity(error: unknown): boolean
export function botOperation(args: readonly string[]): boolean
export function routedArguments(input: readonly string[]): { args: string[]; identity: 'user' | 'bot' | undefined }
