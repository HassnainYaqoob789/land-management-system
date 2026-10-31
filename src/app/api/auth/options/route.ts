import { publicRoute } from '@/lib/iam/public';
import { json } from '@/lib/iam/http';
import { signinOptions } from '@/lib/iam/sso/flow';

// What the sign-in page may offer, before anyone is signed in: local password,
// passkeys, and every configured provider — each marked available or not, so
// an unusable method is shown with SIGNIN_UNAVAILABLE_MESSAGE instead of as a
// button that fails. No account, configuration or secret is included.
export const GET = publicRoute(async () => json(await signinOptions()));
