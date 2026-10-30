import { readdir, rename, unlink } from 'node:fs/promises';

/** @returns {import('astro').AstroIntegration} */
export default function singleSitemap() {
  return {
    name: 'verikun-single-sitemap',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const files = await readdir(dir);
        if (!files.includes('sitemap-0.xml') || !files.includes('sitemap-index.xml')) {
          throw new Error('Expected sitemap-0.xml and sitemap-index.xml from Starlight.');
        }
        if (files.filter((file) => /^sitemap-\d+\.xml$/.test(file)).length !== 1) {
          throw new Error('Cannot publish a single sitemap: multiple numbered sitemaps were generated.');
        }

        await rename(new URL('sitemap-0.xml', dir), new URL('sitemap.xml', dir));
        await unlink(new URL('sitemap-index.xml', dir));
        logger.info('Published sitemap.xml');
      },
    },
  };
}
