module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      {
        npmPublish: false,
      },
    ],
    // Tag + GitHub Release only. Kein Rück-Commit ins Repo (kein
    // @semantic-release/git), damit der Tag stets auf einen echten
    // Code-Commit zeigt statt auf einen leeren Version-Bump.
    [
      '@semantic-release/github',
      {
        assets: [{ path: 'brickrelic-release.zip', label: 'BrickRelic App Distribution' }],
      },
    ],
  ],
};
