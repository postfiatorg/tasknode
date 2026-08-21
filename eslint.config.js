import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import globals from "globals";

const appFiles = ["src/**/*.{js,jsx}", "shared/**/*.js"];
const nodeFiles = ["server/**/*.js", "scripts/**/*.mjs"];

const baseRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
  }],
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "mocks/**",
      "work_in_progress/**",
      "tasknodeofficial_wip/**",
      "coverage/**",
    ],
  },
  {
    files: appFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "jsx-a11y": jsxA11y,
      react,
      "react-hooks": reactHooks,
    },
    rules: {
      ...baseRules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react/jsx-no-undef": "error",
      "react/jsx-uses-vars": "error",
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
    },
  },
  {
    files: nodeFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: baseRules,
  },
];
