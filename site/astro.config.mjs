import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';

// Deployed to Cloudflare from this directory: root `site`, build `bun run build`,
// output `site/dist`. A static build needs no Cloudflare adapter.
//
// `inlineStylesheets: 'always'` is not a size optimisation here — it is what
// makes the pages self-contained, which is the same property the report and
// wrapped HTML have. The site and the artifacts it documents load nothing from
// anywhere else.
export default defineConfig({
  site: 'https://sessions.engineering',
  build: {
    inlineStylesheets: 'always',
    assets: '_assets',
  },
  vite: { plugins: [tailwind()] },
});
