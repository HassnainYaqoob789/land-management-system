import { isProd } from './config';
/** The SSO staging simulator signs anyone in by name with no credential. It is
 * a demonstration aid only: refused in production builds, and off unless
 * explicitly switched on for a local demo. */
export const simulatorEnabled = () => !isProd && process.env.IAM_ENABLE_SSO_SIMULATOR === 'true';
