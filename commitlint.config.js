/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'chore',
        'refactor',
        'test',
        'perf',
        'ci',
        'build',
        'revert',
        'style',
      ],
    ],
    'subject-case': [2, 'never', ['upper-case', 'start-case', 'pascal-case']],
    'body-max-line-length': [1, 'always', 100],
  },
};
