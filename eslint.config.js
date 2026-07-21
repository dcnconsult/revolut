import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.secrets/**',
      'docs/reference/business.yml'
    ]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
