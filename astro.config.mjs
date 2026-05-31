import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://espeutn.github.io',
  base: '/IRG',
  integrations: [tailwind()],
});
