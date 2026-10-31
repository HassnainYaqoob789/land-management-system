import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
// The legacy design system, in the order legacy-demo loads it.
import '@/styles/legacy/tokens.css';
import '@/styles/legacy/base.css';
import '@/styles/legacy/layout.css';
import '@/styles/legacy/components.css';
import '@/styles/legacy/utilities.css';
import '@/styles/legacy/responsive.css';
import '@/styles/legacy/print.css';
import '@/styles/legacy/features.css';
import '@/styles/app.css';
import '@/styles/print-document.css';
import { RouteAnnouncer } from '@/components/legacy/a11y';

// Each route sets its own title on the client (RouteAnnouncer, UX-10); this is
// the title before that runs. Icons are generated from the official logo
// (public/images/mari-energies-logo.png → public/images/icons, macOS sips).
export const metadata: Metadata = {
  title: 'Land Management System · Mari Energies LMS',
  description: 'Mari Energies Limited land management for E&P concessions across Sindh, Punjab, Balochistan and Khyber Pakhtunkhwa.',
  applicationName: 'Mari Energies LMS',
  icons: {
    icon: [
      { url: '/images/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/images/icons/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/images/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/images/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    shortcut: [{ url: '/images/icons/favicon.ico', sizes: '32x32', type: 'image/x-icon' }],
    apple: [{ url: '/images/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Rendered per request so each page carries the nonce its CSP names (src/middleware.ts).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* Sets data-theme from the saved preference before first paint. */}
        <script src="/theme-init.js" nonce={nonce} />
      </head>
      <body>
        {children}
        <RouteAnnouncer />
      </body>
    </html>
  );
}
