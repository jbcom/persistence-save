import { defineConfig, markdown } from 'sourcey';

export default defineConfig({
  name: 'persistence-save',
  siteUrl: 'https://jonbogaty.com',
  baseUrl: '/persistence-save',
  theme: {
    preset: 'default',
    colors: {
      primary: '#1c3a52',
      light: '#377eb7',
      dark: '#0d1b26',
    },
    fonts: {
      sans: 'system-ui, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    layout: {
      sidebar: '17rem',
      toc: '18rem',
      content: '46rem',
    },
    css: ['./brand.css'],
  },
  favicon: './assets/favicon.svg',
  repo: 'https://github.com/jbcom/persistence-save',
  editBranch: 'main',
  editBasePath: 'docs',
  prettyUrls: 'slash',
  navbar: {
    links: [
      { type: 'github', href: 'https://github.com/jbcom/persistence-save' },
      { type: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/persistence-save' },
    ],
  },
  footer: {
    links: [
      {
        type: 'link',
        label: 'MIT License',
        href: 'https://github.com/jbcom/persistence-save/blob/main/LICENSE',
      },
      {
        type: 'link',
        label: 'Security',
        href: 'https://github.com/jbcom/persistence-save/security/policy',
      },
    ],
  },
  navigation: {
    tabs: [
      {
        tab: 'Documentation',
        slug: '',
        source: markdown({
          groups: [
            {
              group: 'Getting Started',
              pages: ['introduction', 'getting-started'],
            },
            {
              group: 'Guides',
              pages: ['migrations', 'web-assets'],
            },
            {
              group: 'Reference',
              pages: ['API', 'ARCHITECTURE'],
            },
            {
              group: 'Project',
              pages: ['contributing', 'decisions'],
            },
          ],
        }),
      },
    ],
  },
});
