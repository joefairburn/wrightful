---
"@wrightful/reporter": patch
---

Prefer the PR title over a GitHub-generated merge message on GitHub Actions.

`refs/pull/N/merge` is not the only commit GitHub writes a `Merge <sha> into <sha>`
message for: the **"Update branch"** button pushes one onto the PR *head*. So the
head commit's own `git log` message — rank 1 in the fidelity chain, and normally
the best source there is — can itself be two bare object names, and the PR title
sitting at rank 2 was never reached. Runs landed titled with 80 characters that
say strictly less than the branch, PR, and sha reported alongside them.

A generated merge message now becomes its own rank rather than a special case:
demoted below the PR title, still ahead of nothing, so a run with no PR title in
the event payload keeps the only message available instead of trading it for a
different useless one from `HEAD`.

Detection is deliberately narrow — `Merge <sha> into <sha>` and nothing else. The
pattern has no `/m` flag and is tested against the whole message, so `$` matches
end-of-input only: a merge carrying a real subject (`Merge branch 'main' into
fix/x`) or any hand-written body counts as authored and is kept.
