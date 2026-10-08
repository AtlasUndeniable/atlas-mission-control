/** One cryptographic UUID per explicit operation, including non-secure preview origins.
 * Never substitute timestamps or Math.random; no entropy means no request.
 * This does not retry a mutation or change its revision/idempotency binding.
 */
export function operationId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('This browser cannot create a secure operation ID. No change was sent. Use a supported browser.');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
  return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10)].map(p => p.join('')).join('-');
}
