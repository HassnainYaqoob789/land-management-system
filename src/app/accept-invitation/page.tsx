import { redirect } from 'next/navigation';

// An invitation is redeemed exactly like a password reset token, with
// purpose=invitation (POST /api/auth/password/reset → iam.redeem_token), so
// the invitation link opens the same set-password form.
export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await searchParams;
  redirect(`/reset-password?purpose=invitation&token=${encodeURIComponent(token ?? '')}`);
}
