import { protect } from '@/lib/iam/http';
import { reauthOptions } from '@/lib/iam/passkey';

// "Confirm it's you" with a passkey instead of the password.
export const POST = protect({ authenticatedOnly: true }, (ctx) => reauthOptions(ctx));
