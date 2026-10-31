// Which settings are identity / security policy. Client-safe (no server
// imports): the settings API and the settings screen both use it.
//
//   * iam.* and security.* are authentication policy. Only holders of
//     identity_settings:read may see them (UI-11), and only
//     identity_settings:configure may change them, through iam.set_policy,
//     which validates every value (AUTHZ-16 / IAMDB-08).
//   * workflow.admin_override and workflow.sod_mode are also changed through
//     iam.set_policy (it refuses turning the override on), but stay readable to
//     every settings reader.
// The database is authoritative: api.set_setting refuses all of these keys.

export const isIdentityPolicyKey = (key: string) => key.startsWith('iam.') || key.startsWith('security.');

const WORKFLOW_POLICY = new Set(['workflow.admin_override', 'workflow.sod_mode']);
export const isPolicyKey = (key: string) => isIdentityPolicyKey(key) || WORKFLOW_POLICY.has(key);

export type PolicyField =
  | { type: 'number'; min: number; max: number; unit?: string }
  | { type: 'boolean' }
  | { type: 'choice'; options: [string, string][] }
  | { type: 'roles' }
  /** The database accepts only the current value; shown, not edited. */
  | { type: 'fixed'; note: string };

/** How the settings screen edits each known policy key. The ranges repeat
 * iam.set_policy's checks so the form can say what is allowed before the
 * database refuses it; anything not listed is edited as raw JSON. */
export const POLICY_FIELDS: Record<string, PolicyField> = {
  'security.password_min_length': { type: 'number', min: 10, max: 128, unit: 'characters' },
  'security.max_failed_logins': { type: 'number', min: 3, max: 20, unit: 'attempts' },
  'security.session_minutes': { type: 'number', min: 5, max: 480, unit: 'minutes idle' },
  'iam.session_absolute_hours': { type: 'number', min: 1, max: 72, unit: 'hours' },
  'iam.lockout_minutes': { type: 'number', min: 1, max: 1440, unit: 'minutes' },
  'iam.password_history': { type: 'number', min: 0, max: 20, unit: 'previous passwords' },
  'iam.reauth_minutes': { type: 'number', min: 1, max: 60, unit: 'minutes' },
  'iam.rate_limit_per_ip': { type: 'number', min: 5, max: 1000, unit: 'failures per window' },
  'iam.rate_limit_per_user': { type: 'number', min: 3, max: 100, unit: 'failures per window' },
  'iam.rate_limit_window_minutes': { type: 'number', min: 1, max: 1440, unit: 'minutes' },
  'iam.recovery_token_minutes': { type: 'number', min: 5, max: 1440, unit: 'minutes' },
  'iam.invitation_hours': { type: 'number', min: 1, max: 336, unit: 'hours' },
  'iam.mfa_required_all': { type: 'boolean' },
  'iam.mfa_required_roles': { type: 'roles' },
  'iam.local_login_enabled': { type: 'boolean' },
  'iam.provisioning_mode': { type: 'choice', options: [['approval', 'An administrator approves each new external user'], ['auto', 'Create the account automatically (no roles until a group mapping applies)']] },
  'iam.link_by_email': { type: 'choice', options: [['never', 'Never link by e-mail address'], ['verified', 'Link to an unlinked local account with the same verified e-mail']] },
  'iam.provider_failure_behavior': { type: 'choice', options: [['deny', 'Refuse sign-in'], ['break_glass_only', 'Only emergency-access accounts may sign in']] },
  'workflow.admin_override': { type: 'fixed', note: 'Off. Separation of duties keeps it off: give the approval position to an authorised officer instead.' },
  'workflow.sod_mode': { type: 'fixed', note: 'Strict. Only strict separation of duties is supported.' },
};
