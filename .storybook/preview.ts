import type { Preview } from '@storybook/react-vite'
import '../src/styles/globals.css' // tokens.css + ui.css 전이 로드

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
  },
  globalTypes: {
    theme: {
      description: '라이트(Paper/Petrol) / 다크(기존 다크 테마)',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light (Paper/Petrol)' },
          { value: 'dark', title: 'Dark (classic)' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, ctx) => {
      const theme = (ctx.globals.theme as string) ?? 'light'
      document.documentElement.dataset.theme = theme
      document.body.style.background = theme === 'dark' ? '#0f0f0f' : '#fafaf6'
      return Story()
    },
  ],
}

export default preview
