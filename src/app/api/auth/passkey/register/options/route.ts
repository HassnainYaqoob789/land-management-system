import { protect } from '@/lib/iam/http';
import { registrationOptions } from '@/lib/iam/passkey';

// Adding a passkey is a change to how the account signs in: it needs a recent
// re-authentication. It is allowed while MFA enrolment is outstanding, since a
// passkey satisfies it.
export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true, reauth: true }, (ctx) => registrationOptions(ctx));
