/** Lê o corpo até `max` bytes; `undefined` se passar (cobre pedido sem content-length). */
export async function readLimited(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return undefined;
  if (request.body === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
