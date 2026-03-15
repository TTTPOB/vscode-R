each atomic change need to be commited.
each commit message should be semantic.
before you do any task, check bd status to see if it has been created as an issue, if not, create it.
after you've done a task, update the bd issue with what you've done.
each time before you read from bd, run bd sync to sync it.

## Release workflow

### Changelog generation with git-cliff

This project uses `git-cliff` (binary at `~/.cargo/bin/git-cliff`) with config in `cliff.toml`.

**Important**: When generating the changelog for a new release, always use the `--tag` flag to assign a version to unreleased commits:

```bash
git-cliff --tag v<VERSION> --output CHANGELOG.md
```

Without `--tag`, commits after the latest git tag will appear under "Unreleased" instead of the target version. The `--tag` flag tells git-cliff to treat those commits as belonging to the specified version, even before the actual git tag exists.

**Recommended release sequence**:
1. Make all code changes and commit
2. Run `git-cliff --tag v<VERSION> --output CHANGELOG.md` to generate changelog
3. Commit the changelog
4. Tag: `git tag v<VERSION>`
5. Push: `git push && git push origin v<VERSION>`
6. The GitHub Actions release workflow (`.github/workflows/release.yml`) triggers on `v*` tags and handles building, releasing, and publishing to VS Marketplace.