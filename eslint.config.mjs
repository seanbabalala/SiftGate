import globals from 'globals';
import tseslint from 'typescript-eslint';

const baseRules = {
  'no-console': 'off',
  'no-constant-condition': 'error',
  'no-debugger': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-empty-pattern': 'error',
  'no-fallthrough': 'error',
  'no-irregular-whitespace': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-var': 'error',
  'prefer-const': 'warn',
};

export default [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'dist-runtime-plugins/**',
      'frontend/**',
      'node_modules/**',
      'siftgate-cloud/**',
    ],
  },
  {
    files: ['{src,test}/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...baseRules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.{js,cjs,mjs}', 'src/alerts/alert-connector-runtime.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: baseRules,
  },
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...baseRules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
];
