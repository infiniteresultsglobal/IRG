import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

const isNetlify = process.env.NETLIFY === 'true';

export default defineConfig({
  site: isNetlify ? 'https://infinett.netlify.app' : 'https://espeutn.github.io',
  base: isNetlify ? '/' : '/IRG',
  integrations: [tailwind()],
});
