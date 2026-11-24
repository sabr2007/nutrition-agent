import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Рядом — коуч по питанию',
    short_name: 'Рядом',
    description: 'Личный AI-коуч по питанию',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#efede4',
    theme_color: '#efede4',
    lang: 'ru',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512?maskable=1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Записать еду', short_name: 'Записать', url: '/log' },
      { name: 'Коуч', url: '/coach' },
    ],
  };
}
