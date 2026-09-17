// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The rule that matters is `stock/no-balance-writes` below. Everything else is
 * ordinary hygiene.
 *
 * CLAUDE.md tells contributors that an ESLint rule confines writes to
 * `stock_balances` to the movement repository. This file is that rule. A
 * documented guardrail that does not exist is worse than no guardrail: people
 * stop looking for the thing they have been told is checked.
 */

/** Prisma model calls that mutate. Reads are unrestricted. */
const MUTATING =
  '/^(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)$/';

/**
 * Both ways to write the balance table: through Prisma's model API, and
 * through raw SQL. The second matters as much as the first — the conditional
 * UPDATE at the heart of this project is raw SQL, so "it's raw SQL" is not a
 * signal that something is exempt from the rule.
 */
const BALANCE_WRITE_RULES = [
  {
    selector: `CallExpression > MemberExpression[object.property.name='stockBalance'][property.name=${MUTATING}]`,
    message:
      'Only server/src/modules/movements/repository.ts may write to stock_balances. ' +
      'Stock changes by appending a movement — see the four stock rules in CLAUDE.md.',
  },
  {
    selector:
      "TemplateElement[value.raw=/(?:UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+stock_balances/i]",
    message:
      'Raw SQL writing stock_balances belongs in server/src/modules/movements/repository.ts. ' +
      'The zero floor is one atomic conditional UPDATE and it lives in exactly one place.',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'] },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-restricted-syntax': ['error', ...BALANCE_WRITE_RULES],

      // An unused variable in this codebase is usually a half-finished edit.
      // Leading underscore is the escape hatch, used by the error handler's
      // mandatory fourth argument and by destructured discards.
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

      // `any` defeats the point of validating at the boundary. The casts that
      // survive are `req.query as never` at route handlers, which is narrowing
      // an Express type rather than widening one of ours.
      '@typescript-eslint/no-explicit-any': 'error',

      // A floating promise here loses an audit write or an error. Both matter.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  {
    // Type-aware rules need the program. Scoped to source we own.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  {
    /**
     * The one file allowed to write stock_balances.
     *
     * This exemption is the rule's whole design: rather than trusting every
     * author to remember rule 4, the restriction is on by default everywhere
     * and lifted in a single named file that is 180 lines long and entirely
     * about this one problem.
     */
    files: ['src/modules/movements/repository.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    /**
     * The one test allowed to write stock_balances — because writing to it is
     * the thing under test.
     *
     * It reaches past the application to attack the CHECK constraint directly,
     * proving the zero floor holds even against code that skips every layer
     * above it. That is the opposite of the mistake this rule guards against,
     * so it is exempt by name rather than by an inline disable that would blend
     * in with a genuine violation.
     */
    files: ['tests/immutability.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // The reconciliation script prints a rebuild statement for a human to run.
    // It is a string in a report, never executed — but it is a template
    // literal containing `INSERT INTO stock_balances`, so the rule sees it.
    files: ['src/scripts/reconcile.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
