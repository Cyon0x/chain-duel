import next from "eslint-config-next/core-web-vitals";

const config = [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "contracts/**",
      "next-env.d.ts",
      "src/generated/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // Advisory React Compiler diagnostic; Chain Duel does not enable the
      // compiler, and the manual memoization here is deliberate.
      "react-hooks/preserve-manual-memoization": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
