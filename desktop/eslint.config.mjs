import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "dist/**", "build/**"] },
  js.configs.recommended,
  {
    // The shell: CommonJS, main process, Node globals.
    files: ["main.js", "lib/**/*.js"],
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
    // The shell's own pages run in a browser context with the preload bridge.
    // icons.js defines ICONS for the other two, which load it first.
    files: ["ui/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ICONS: "readonly" },
    },
    rules: {
      // Each page is loaded as its own classic script; the top-level `const`s
      // they share names for are in separate global scopes at runtime.
      "no-redeclare": "off",
      "no-unused-vars": ["warn", { varsIgnorePattern: "^(ICONS)$" }],
    },
  },
  {
    // The preload runs in a renderer, with require() and the DOM both.
    files: ["preload.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
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
