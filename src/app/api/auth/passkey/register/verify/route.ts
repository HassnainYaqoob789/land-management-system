import { protect, readJson } from '@/lib/iam/http';
import { registrationVerify } from '@/lib/iam/passkey';

export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true, reauth: true }, async (ctx) =>
  registrationVerify(ctx, await readJson(ctx.req, 40_000)));
