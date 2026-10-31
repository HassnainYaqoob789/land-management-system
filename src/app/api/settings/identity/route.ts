import { json, protect } from '@/lib/iam/http';
import { identityAdminData } from '@/lib/iam/sso/admin';

// Identity administration: sign-in methods and their status, group mappings,
// access requests from first-time external users, emergency-access accounts
// and the identity / security policy. Secrets are never part of the answer.
export const GET = protect({ permission: ['identity_settings', 'read'] }, async (ctx) => json(await identityAdminData(ctx)));
