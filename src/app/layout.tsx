import type { Metadata, Viewport } from 'next';
import { Literata, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorker } from '@/components/system/ServiceWorker';

const literata = Literata({ variable: '--font-literata', subsets: ['latin', 'cyrillic'], display: 'swap', axes: ['opsz'] });
const plexMono = IBM_Plex_Mono({ variable: '--font-plex-mono', subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600'], display: 'swap' });

export const metadata: Metadata = {
  title: 'Рядом — питание без надзирателя',
  description: 'Личный AI-коуч по питанию: записи за 5 секунд, напоминания по контексту, честные цифры.',
  applicationName: 'Рядом',
  appleWebApp: { capable: true, title: 'Рядом', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#efede4',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ru" className={`${literata.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full">
        <div className="relative z-[1] min-h-dvh">{children}</div>
        <ServiceWorker />
      </body>
    </html>
  );
}
