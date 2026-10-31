// The pre-IAM helpers that lived here are gone, deliberately:
//   * getCurrentUser() trusted a bare user id in a cookie and fell back to the
//     Admin account when there was no cookie at all;
//   * authenticateUser() accepted a login with no password;
//   * getDemoAccounts() listed every account to anyone.
// Use protect() from '@/lib/iam/http' in route handlers, which resolves a real
// session. Importing anything from here is now a compile error.
export {};
