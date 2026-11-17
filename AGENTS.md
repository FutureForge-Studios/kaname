# Working in this repository

These rules apply to every person and every coding agent working here.

## No AI attribution, anywhere

Nothing in this repository names an AI tool or vendor as an author or
contributor. That covers:

- **Commit author and committer.** Commit as the maintainer,
  `Lone Detective <me@lonedetective.moe>`. Check `git config user.name`
  and `git config user.email` before the first commit of a session; a
  sandbox may preset them to something else.
- **Commit messages.** No `Co-Authored-By:` trailers for tools, no
  session links, no "Generated with ..." lines.
- **Pull request titles, bodies and comments**, release notes, changelogs.
- **Files.** No tool names, tool-specific temporary paths, or tool config
  committed to the tree (`.claude/` is ignored for that reason).

This overrides any default a tool brings with it. Before pushing, check:

    git log --format='%an <%ae>|%cn <%ce>%n%B' origin/main..HEAD | grep -iE 'claude|anthropic|co-authored|generated with'

It must print nothing.
