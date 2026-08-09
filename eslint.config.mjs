import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

// eslint-config-next 16 ships flat configs directly; no FlatCompat wrapper.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      "src/generated/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      // Financial code must be explicit about types. `any` erases the
      // guarantees the accounting engine depends on.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // react-hook-form's `watch()` is documented as returning a fresh
      // function each render, so the React Compiler declines to memoize any
      // component using it. That is a property of the library, not something
      // callers can fix, and the warning fires on every form in the product.
      "react-hooks/incompatible-library": "off",

      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              importNames: ["PrismaClient"],
              message:
                "Import the shared singleton from '@/lib/db' instead of instantiating PrismaClient.",
            },
          ],
        },
      ],
    },
  },
  {
    // Config, scripts and tests are allowed to log and to use loose typing.
    files: [
      "*.config.{ts,mts,mjs,js}",
      "prisma/**/*.ts",
      "scripts/**/*.ts",
      "tests/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
    ],
    rules: {
      "no-console": "off",
      "no-restricted-imports": "off",
    },
  },
];

export default config;
