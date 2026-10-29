import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat ESLint configuration.
 *
 * Type-aware linting is applied to the TypeScript that belongs to a tsconfig, because it is
 * the only way ESLint can see cross-file facts such as whether a floating promise or an
 * unsafe `any` actually reaches a real call site. Plain `.mjs` scripts stay runnable
 * without a tsconfig.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "data/**"],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Type-aware rules for the application and its tests.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vite.config.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Every project is listed explicitly. The project *service* only discovers a file
        // through the nearest `tsconfig.json`, so frontend files under `tsconfig.web.json`
        // and DOM tests under `tsconfig.domtest.json` would otherwise be invisible to the
        // type-aware rules.
        project: ["./tsconfig.json", "./tsconfig.web.json", "./tsconfig.domtest.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },

  // `node:test`'s `describe` and `it` return promises that the runner owns and awaits. The
  // rule cannot know that, so it reports every test declaration as a floating promise.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },

  // Browser globals for the frontend only. Server code has no `window` or `document`, so a
  // browser API used in the wrong layer is a type error rather than a runtime surprise.
  {
    files: ["src/web/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },

  // The renderer tests execute real DOM code, so they need browser globals too. They are
  // type-checked by `tsconfig.domtest.json` rather than the server project, which is what
  // keeps `document` out of reach for server code.
  {
    files: [
      "tests/unit/chart-render.test.ts",
      "tests/unit/source-status.test.ts",
      "tests/unit/widget-value.test.ts",
      "tests/helpers/dom.ts",
      // `page.evaluate` callbacks are serialised and executed inside the browser, so the
      // browser globals are genuinely in scope there even though the file runs in Node.
      // Any script that drives a real browser belongs in this list.
      "scripts/screenshot.mjs",
      "scripts/verify-integration.mjs",
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },

  // Node globals for the server, the tests and the policy gate scripts.
  {
    files: ["src/main.ts", "src/server/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs", "*.js"],
    languageOptions: { globals: globals.node },
  },

  // The gate scripts and config files are plain JavaScript, so type-aware TS rules and the
  // type-only import rule do not apply to them.
  {
    files: ["scripts/**/*.mjs", "*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
