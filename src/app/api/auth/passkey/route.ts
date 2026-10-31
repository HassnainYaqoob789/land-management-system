import { protect } from '@/lib/iam/http';
import { listOwn, removeOwn } from '@/lib/iam/passkey';

// Your own passkeys. Listing is open while MFA enrolment is outstanding (a
// passkey can be that enrolment); removing one needs a recent re-authentication,
// and the database refuses to remove the last way to sign in.
export const GET = protect({ authenticatedOnly: true, allowPendingMfa: true }, (ctx) => listOwn(ctx));

export const DELETE = protect({ authenticatedOnly: true, reauth: true }, (ctx) =>
  removeOwn(ctx, new URL(ctx.req.url).searchParams.get('id')));
