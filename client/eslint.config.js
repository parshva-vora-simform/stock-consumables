// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The client's own guardrail is `no-restricted-syntax` below: `useOptimistic`
 * is banned outright.
 *
 * React 19 makes an optimistic update a two-line change, and for a stock-out it
 * would be exactly wrong — it tells the operator they got the last unit before
 * the database has decided whether they did. That is the human version of the
 * race this whole project exists to prevent, so it is refused mechanically
 * rather than left to review.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='useOptimistic']",
          message:
            'No optimistic updates for stock. The server is the sole authority on whether a ' +
            'movement succeeded — see the client conventions in CLAUDE.md (FR-4.3).',
        },
        {
          selector:
            "CallExpression[callee.object.name='localStorage'][callee.property.name=/^(setItem|getItem)$/] > Literal[value=/token/i]",
          message:
            'Access tokens live in memory, not localStorage. Token storage belongs in ' +
            'src/api/client.ts, which documents exactly what it keeps and why.',
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          // `const { unitOfMeasure, ...rest } = body` is a deliberate omission,
          // not a forgotten variable. The rest sibling is the whole point.
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  {
    // The token store is the one module that may name a token in storage —
    // it holds the refresh token deliberately, and says so.
    files: ['src/api/client.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
