import { randomUUID } from 'node:crypto';
import { json, sameOrigin, toResponse } from './http';
/** Wrapper for the few routes that must work without a session (login, reset). */
export function publicRoute(h: (req: Request, corr: string) => Promise<Response>) {
  return async (req: Request) => {
    const corr = randomUUID();
    try {
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return json({ error: 'Cross-origin request refused.', code: 'csrf', correlationId: corr }, 403);
      return await h(req, corr);
    } catch (e) { return toResponse(e, corr); }
  };
}
