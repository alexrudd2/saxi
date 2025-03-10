module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', '@stylistic/eslint-plugin'],
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  root: true,
  rules: {
    // Place to specify ESLint rules. Can be used to overwrite rules specified from the extended configs
    // e.g. "@typescript-eslint/explicit-function-return-type": "off",
    indent: "off",
    "@typescript-eslint/no-use-before-define": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-unused-vars": ["error", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    }],
    '@stylistic/indent': ['error', 2],
    "@stylistic/space-infix-ops": 1,
    '@stylistic/object-curly-spacing': ['error', 'always'],
    "@stylistic/space-before-function-paren": ["error", "never"],
    "semi": [1, "always"],
    "consistent-return": 2,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  ignorePatterns: [
    '*.js',
    '__tests__',
  ],
};
