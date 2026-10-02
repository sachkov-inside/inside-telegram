---
name: session-cleanup
description: "Clean up what an agent session started: worktree, local branch, containers, volumes, stand processes, stash entries and temporary files. Use as the last step of a task, before the closing report, or when asked to clean up after a session."
---

Cleanup is the writing agent's last step. A session is complete when nothing it started keeps
running and its local state is clean. Touch only what this session started; name the owner of
anything else in the report and leave it in place.

## 1. List the leftovers

Run from the repository root:

```bash
git worktree list; git branch -vv | grep ': gone]'; git stash list; \
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project.working_dir"}}'; \
docker volume ls -f dangling=true --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}'; \
lsof -nP -iTCP -sTCP:LISTEN
```

The Compose working directory, the Compose project of a volume, and a process's current directory
show which worktree owns a resource. Read a listening process's directory with
`lsof -a -p <pid> -d cwd`; on Linux without `lsof`, use `ss -ltnp` and `readlink /proc/<pid>/cwd`.

## 2. Always

- Stop and remove the containers, volumes and stand processes the session started, and free their
  ports.
- Delete the temporary files the session created outside the worktree.

## 3. While the pull request is open

Keep the worktree and the task branch. Do step 2 only.

## 4. After the merge, or when the issue closed without a pull request

1. Check that the worktree has no uncommitted changes and that every commit is kept by a remote
   branch or the merged pull request. A squash-merged pull request keeps its commits even when
   they are not ancestors of `main`.
2. Remove the worktree and delete the local task branch. For a squash-merged branch use
   `git branch -D`.
3. Run `git worktree prune`. Delete merged local branches whose upstream is gone, unless a
   worktree still uses them.
4. Find the session's safety stash entries by their messages. Compare each with the merged pull
   request, then drop it.
5. Fast-forward the primary checkout to `origin/main` only when it is on `main` and has no
   uncommitted changes. Otherwise leave it and name the branch or files that prevented the update.

If unpublished work remains after the merge, keep the worktree and report the exact blocker.

## Done when

The command from step 1 shows nothing that this session started, or the report names each
leftover and why it stays.
