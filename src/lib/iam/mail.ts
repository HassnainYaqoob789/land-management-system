import { deliver, type MailMessage, type MailResult } from './mailer';

// Mail goes through the SMTP transport in ./mailer only. There is no console
// or "pretend" transport: a message is reported as delivered only when an
// SMTP server accepted it, and an unconfigured server means nothing is sent.

export type { MailMessage, MailResult };

/** Full result, so the caller can record why a message was not delivered. */
export const deliverMail = (m: MailMessage): Promise<MailResult> => deliver(m);

/** True only when the SMTP server accepted the message. */
export async function sendMail(m: MailMessage): Promise<boolean> {
  return (await deliver(m)).delivered;
}
