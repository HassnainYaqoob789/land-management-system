import { protect, readJson } from '@/lib/iam/http';
import { reauthVerify } from '@/lib/iam/passkey';

export const POST = protect({ authenticatedOnly: true }, async (ctx) => reauthVerify(ctx, await readJson(ctx.req, 16_384)));
