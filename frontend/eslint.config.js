import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two React-official hook rules. The plugin's v7 "recommended" preset
      // adds the whole React Compiler set (purity, set-state-in-effect, …),
      // which is too strict for the legacy code — start with the classics.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The codebase predates linting; surface dead code without failing CI.
      // `_` is the established "intentionally unused" convention (map index,
      // useState setter destructure, catch bindings) — don't flag those.
      "no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" },
      ],
      // Intentional `catch {}` guards are everywhere; still flag empty
      // if/for/function bodies as real errors.
      "no-empty": ["error", { "allowEmptyCatch": true }],
    },
  },
  prettier,
];
