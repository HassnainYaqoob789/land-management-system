import { publicRoute } from '@/lib/iam/public';
import { json } from '@/lib/iam/http';

// Retired with the simulator (see ../login/route.ts). Each protocol has its own
// callback: /api/auth/oidc/<name>/callback and /api/auth/saml/<name>/acs.
const gone = publicRoute(async () =>
  json({ error: 'Single sign-on starts from the sign-in page.', code: 'sso_not_configured', options: '/api/auth/options' }, 404));
export const GET = gone;
export const POST = gone;
