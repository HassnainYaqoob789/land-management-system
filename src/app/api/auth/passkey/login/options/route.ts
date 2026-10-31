import { publicRoute } from '@/lib/iam/public';
import { readJson } from '@/lib/iam/http';
import { loginOptions } from '@/lib/iam/passkey';

// Before sign-in. The optional username only narrows the later check; the
// answer is the same whether or not the account exists.
export const POST = publicRoute(async (req) => loginOptions(req, await readJson(req, 1024)));
