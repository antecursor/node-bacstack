'use strict';

const js = require('@eslint/js');
const stylistic = require('@stylistic/eslint-plugin');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'docs/**',
      'node_modules/**',
      'reports/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    plugins: {
      '@stylistic': stylistic
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/indent': ['error', 2, {SwitchCase: 1}],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
      '@stylistic/semi': ['error', 'always'],
      complexity: ['error', 50],
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      'guard-for-in': 'error',
      'max-depth': ['error', 5],
      'max-params': ['error', 15],
      'max-statements': ['error', 100],
      'no-case-declarations': 'error',
      'no-constant-binary-expression': 'error',
      'no-new': 'error',
      'no-unused-vars': 'error',
      'no-useless-assignment': 'error'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: globals.mocha
    }
  }
];
