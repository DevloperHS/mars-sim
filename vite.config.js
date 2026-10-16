import { defineConfig } from 'vite';

// Social crawlers (X, WhatsApp, Facebook, LinkedIn) ignore relative og:image URLs.
const siteUrl = (
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
  'https://mars-two-omega.vercel.app'
).replace(/\/+$/, '');

export default defineConfig({
  plugins: [
    {
      name: 'inject-site-url',
      transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl),
    },
  ],
});
