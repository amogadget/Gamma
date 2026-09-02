import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "dist/**", "build/**"] },
  js.configs.recommended,
  {
    // The shell: CommonJS, main process, Node globals.
    files: ["*.js", "chooser/preload.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `catch {}` around "it might not exist / already gone" is deliberate
      // throughout the supervisor; empty blocks elsewhere are still errors.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // The chooser renderer runs in a browser context with the preload bridge.
    files: ["chooser/chooser.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Node, plus browser globals for the callbacks handed to page.evaluate()
      // and page.waitForFunction() — those bodies run in the app's page.
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
