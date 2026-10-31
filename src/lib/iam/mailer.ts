import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

// Outbound mail over SMTP, configured only from the environment:
//   SMTP_HOST, SMTP_FROM            required
//   SMTP_PORT                       default 465 with SMTP_SECURE=true, else 587
//   SMTP_SECURE                     'true' = TLS from the first byte (465);
//                                   otherwise STARTTLS is REQUIRED (never plain text)
//   SMTP_USER, SMTP_PASSWORD        optional, both or neither
//   SMTP_CA_FILE                    optional PEM bundle (a private CA); the
//                                   certificate is always verified
// Missing or bad settings fail closed: nothing is sent and the caller is told
// why, so it can record the failure. A message's body is never logged.

export interface MailMessage { to: string; subject: string; text: string }
export type MailFailure = 'not_configured' | 'misconfigured' | 'invalid_recipient' | 'rejected' | 'transport_error';
export type MailResult = { delivered: true; messageId: string } | { delivered: false; reason: MailFailure; detail?: string };

interface SmtpConfig { host: string; port: number; secure: boolean; from: string; auth?: { user: string; pass: string }; ca?: string }
type ConfigState = { ok: true; cfg: SmtpConfig } | { ok: false; reason: 'not_configured' | 'misconfigured'; detail: string };

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
/** "addr@x.y" or "Display Name <addr@x.y>", no line breaks. */
const validFrom = (v: string) => !/[\r\n]/.test(v)
  && (ADDRESS.test(v) || (/^[^<>]{1,100}<[^<>\s]+>$/.test(v) && ADDRESS.test(v.slice(v.lastIndexOf('<') + 1, -1))));

export function smtpConfig(env: NodeJS.ProcessEnv = process.env): ConfigState {
  const host = env.SMTP_HOST?.trim(), from = env.SMTP_FROM?.trim();
  if (!host) return { ok: false, reason: 'not_configured', detail: 'SMTP_HOST is not set' };
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:.]{2,45}\]?$/.test(host)) return { ok: false, reason: 'misconfigured', detail: 'SMTP_HOST is not a host name or address' };
  if (!from) return { ok: false, reason: 'not_configured', detail: 'SMTP_FROM is not set' };
  if (!validFrom(from)) return { ok: false, reason: 'misconfigured', detail: 'SMTP_FROM is not an e-mail address' };
  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  if (secureRaw && secureRaw !== 'true' && secureRaw !== 'false') return { ok: false, reason: 'misconfigured', detail: "SMTP_SECURE must be 'true' or 'false'" };
  const secure = secureRaw === 'true';
  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT.trim()) : secure ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'misconfigured', detail: 'SMTP_PORT is not a port number' };
  const user = env.SMTP_USER ?? '', pass = env.SMTP_PASSWORD ?? '';
  if (!!user !== !!pass) return { ok: false, reason: 'misconfigured', detail: 'set both SMTP_USER and SMTP_PASSWORD, or neither' };
  let ca: string | undefined;
  if (env.SMTP_CA_FILE?.trim()) {
    try { ca = readFileSync(env.SMTP_CA_FILE.trim(), 'utf8'); } catch { return { ok: false, reason: 'misconfigured', detail: 'SMTP_CA_FILE cannot be read' }; }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) return { ok: false, reason: 'misconfigured', detail: 'SMTP_CA_FILE holds no PEM certificate' };
  }
  return { ok: true, cfg: { host: host.replace(/^\[|\]$/g, ''), port, secure, from, auth: user ? { user, pass } : undefined, ca } };
}

let cached: { state: ConfigState; transport?: ReturnType<typeof nodemailer.createTransport> } | undefined;
let warned = false;
function transport() {
  if (!cached) {
    const state = smtpConfig();
    cached = { state };
    if (state.ok) {
      const { host, port, secure, auth, ca } = state.cfg;
      cached.transport = nodemailer.createTransport({
        host, port, secure, auth,
        requireTLS: !secure,                 // STARTTLS or nothing: no plain-text fallback
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
        disableFileAccess: true, disableUrlAccess: true,
      });
    }
  }
  return cached;
}

/** True when SMTP settings are present and valid (no connection is made). */
export const mailConfigured = () => transport().state.ok;

/** Sends one plain-text message. Never throws; `delivered` is true only when
 * the SMTP server accepted the recipient. */
export async function deliver(m: MailMessage): Promise<MailResult> {
  const t = transport();
  if (!t.state.ok) {
    if (!warned) { warned = true; console.error(`[SECURITY] outbound mail is disabled (${t.state.reason}): ${t.state.detail}`); }
    return { delivered: false, reason: t.state.reason, detail: t.state.detail };
  }
  if (!ADDRESS.test(m.to) || /[\r\n]/.test(m.subject)) return { delivered: false, reason: 'invalid_recipient' };
  try {
    const info = await t.transport!.sendMail({ from: t.state.cfg.from, to: m.to, subject: m.subject, text: m.text,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } });
    const accepted = (info.accepted ?? []).map((a: any) => String(typeof a === 'string' ? a : a?.address).toLowerCase());
    // The status code only: the server's text can repeat the recipient address.
    if (!accepted.includes(m.to.toLowerCase())) return { delivered: false, reason: 'rejected', detail: /^\d{3}/.exec(String(info.response ?? ''))?.[0] };
    return { delivered: true, messageId: String(info.messageId ?? '') };
  } catch (e: any) {
    // Error codes only (ECONNREFUSED, ETLS, EAUTH, ...): no recipient, body or credentials.
    const detail = String(e?.code ?? e?.name ?? 'error').slice(0, 40);
    console.error(`[SECURITY] mail delivery failed: ${detail}`);
    return { delivered: false, reason: 'transport_error', detail };
  }
}

/** For tests: forget the cached configuration and transport. */
export function resetMailerForTests() { cached = undefined; warned = false; }
