/**
 * LU Cloud codes for a request that will fail the same way however often it
 * is sent (the lu-labs.ai chat proxy, 19.11.2026, its chat completions route):
 *
 *  - `images_too_large` (413): the images of the message are over the size
 *    one request may carry, even after the proxy shrank them.
 *  - `request_too_large` (413): the upstream refused the request for its size.
 *  - `unsupported_response_format` (422): the model would not follow the JSON
 *    schema the request asked for (a schema with $ref or one that refers to
 *    itself), after the proxy's own two attempts.
 *
 * Each comes with an English sentence that says what to do and that nothing
 * was charged. LU shows it as it is and sends nothing again: not the
 * thinking ladder of the provider (a 422 normally reads as "drop a knob"),
 * not the thinking downgrade of the chat, not the agent's retry.
 */
export const CLOUD_FINAL_CODES: ReadonlySet<string> = new Set([
  'images_too_large',
  'request_too_large',
  'unsupported_response_format',
])

export function isCloudFinalCode(code: unknown): boolean {
  return typeof code === 'string' && CLOUD_FINAL_CODES.has(code)
}

/** The code of an error answer's JSON body, or undefined. */
export async function finalCodeOf(res: Response): Promise<string | undefined> {
  try {
    const data = await res.clone().json() as { code?: unknown }
    return isCloudFinalCode(data?.code) ? String(data.code) : undefined
  } catch {
    return undefined
  }
}
