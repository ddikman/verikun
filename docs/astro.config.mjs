// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// Project-pages deployment: https://ddikman.github.io/verikun/
// `base` must match the repo name, or every asset 404s and the site renders unstyled.
export default defineConfig({
  site: 'https://ddikman.github.io',
  base: '/verikun',
  integrations: [
    starlight({
      title: 'verikun',
      description:
        'Drive Android devices and iOS simulators the way Puppeteer drives a browser — for AI agents and CI.',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ddikman/verikun' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/verikun' },
      ],
      editLink: {
        baseUrl: 'https://github.com/ddikman/verikun/edit/main/docs/',
      },
      // A dead internal link fails the build. Load-bearing: this migration rewrote 24
      // README anchors into cross-page links, and a silent 404 is the likely regression.
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Your first test', slug: 'getting-started/your-first-test' },
            { label: 'Using it from an AI agent', slug: 'getting-started/using-from-an-agent' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Writing test cases', slug: 'guides/writing-test-cases' },
            { label: 'Natural-language tests', slug: 'guides/natural-language-tests' },
            { label: 'Suites', slug: 'guides/suites' },
            { label: 'Remote devices & CI', slug: 'guides/remote-devices-and-ci' },
            { label: 'Self-healing in CI', slug: 'guides/self-healing-in-ci' },
            { label: 'iOS setup', slug: 'guides/ios-setup' },
            { label: 'Platform support', slug: 'guides/platform-support' },
            { label: 'The Android companion', slug: 'guides/companion' },
            { label: 'Troubleshooting', slug: 'guides/troubleshooting' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Commands', slug: 'reference/commands' },
            { label: 'Selectors', slug: 'reference/selectors' },
            { label: 'Auto-wait & auto-scroll', slug: 'reference/auto-wait' },
            { label: 'Exit codes', slug: 'reference/exit-codes' },
            { label: 'Environment variables', slug: 'reference/environment-variables' },
            { label: 'Reports & test runs', slug: 'reference/reports-and-test-runs' },
            { label: 'Device state', slug: 'reference/device-state' },
            { label: 'Device claims', slug: 'reference/device-claims' },
            { label: 'Screenshots', slug: 'reference/screenshots' },
            { label: 'AI plans & models', slug: 'reference/ai-plans' },
            { label: 'Cost & budget', slug: 'reference/cost' },
          ],
        },
        {
          label: 'Internals',
          items: [
            { label: 'Architecture', slug: 'internals/architecture' },
            { label: 'Core principles', slug: 'internals/core-principles' },
            { label: 'Plan IR & the replay engine', slug: 'internals/plan-ir-and-engine' },
            { label: 'Contracts', slug: 'internals/contracts' },
            { label: 'Contributing', slug: 'internals/contributing' },
          ],
        },
      ],
    }),
  ],
});
