import { publicRoute } from '@/lib/iam/public';
import { readJson } from '@/lib/iam/http';
import { loginVerify } from '@/lib/iam/passkey';

// Completes a passkey sign-in: same response and session cookie as a password sign-in.
export const POST = publicRoute(async (req) => loginVerify(req, await readJson(req, 16_384)));
