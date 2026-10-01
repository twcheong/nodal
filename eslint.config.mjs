// Flat ESLint config — minimum-noise setup focused on the rule that
// would have caught our recent renderer-crash bug (React error #300):
// `react-hooks/rules-of-hooks`. Broader recommended rule sets are
// deliberately NOT enabled here so this config can land without
// drowning the repo in pre-existing warnings; flip them on later when
// the team is ready to triage them.

import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      'patches/**',
      'twixy@0.1.0/**',
      'openclaw-installer/**',
      'scripts/**',
      // 엔진 subtree — 자기 eslint 설정으로 따로 검사한다 (pnpm -C products/nodal/engine lint)
      'products/nodal/engine/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.{ts,tsx}', 'products/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks':       reactHooks,
      // typescript-eslint 의 룰들을 활성화하지는 않지만, 코드에 박혀있는
      // `// eslint-disable-next-line @typescript-eslint/no-unused-vars`
      // 같은 inline disable 주석이 ESLint 에 의해 "unknown rule" 로 에러를
      //내지 않도록 plugin 자체는 등록만 해 둔다.
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // The rule that catches "early return between hooks" → React #300.
      // Hard error: this is never a false positive in practice.
      'react-hooks/rules-of-hooks': 'error',
      // Useful but noisier; keep as warn for now.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
