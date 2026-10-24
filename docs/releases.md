# Releases

Reader: whoever ships a release, or wants to know what one contains.

A release in this repository is one squash-merged pull request to `main`. There are no tags and no long-lived release branch: the merge commit on `main` is the release, its subject is the release line ("Didi release N: ...") and everything in it landed as one unit. The repository is a sole-owner project, so a release is also the moment the owner installs and uses the build.

## The shape of a release

1. A milestone of issues is closed by one pull request against `main`. The pull request body lists the checks run at its head commit and the issues it closes.
2. The branch carries the code and the doc that describes the behaviour in the same commits ([CLAUDE.md](../CLAUDE.md): a change updates the doc that describes it).
3. The head commit passes the twelve-check gate in [checks.md](checks.md). The gate is run at the head, one check at a time, with no rerun on a flake.
4. The pull request is squash-merged. The merge commit's subject becomes the release row.

## What the release row records

[implementation-status.md](implementation-status.md) holds the release table: one row per release, with the ordinal, the date, and one line on what changed for the owner. The row is written from the pull request's own summary, not from the issue tracker, and it names behaviour, not files.

The page's header also names the source state it was written against: `State of the source tree at release N (main <sha>, <date>)`. When the tree moves and the table does not, that line is what tells the reader the page is behind.

## The version pin

`scripts/build-macos-app.sh` writes `didi-runtime.json` into the built app bundle. It pins:

- `releaseCommit`: the commit the bundle was built from, 40 lowercase hex characters; the build refuses anything else;
- `installId`: a fresh per-install identifier;
- `nodePath` and `nodeMajor`: the runtime the bundle carries (Node 26);
- `serverEntry` and `webRoot`: where inside the bundle the service and the web assets live.

The installed app reports `releaseCommit` in its `host_started` log line, so a running app can be traced to a commit; a host started outside the bundle logs `unknown`. A dirty tree still produces a 40-hex commit, which is the commit that was checked out and not the change that was built, and that is why the asset bundle build demands a clean, committed tree.

## Install and prove

```sh
bash scripts/build-asset-bundle.sh /tmp/didi-assets
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
bash scripts/smoke.sh
```

`scripts/install-macos-app.sh` replaces only the app and keeps the previous one beside it until the new one validates. `scripts/smoke.sh` is the real-path smoke: it runs the host the way the native app does (`--supervised`, the app's environment, a staged copy of its configuration), holds its stdout to the native rule, and drives the operator's path: every configured connector, one text turn that must call tools, one Live turn that must call and keep the session open, and one Live voice turn that must run the research loop. Run it after every install and before every release. It is also `check-install-smoke.sh` in the gate.

A release is done when the gate passed at the merged head, the installer put the bundle in place, the smoke passed against the installed app, and the release row is in `implementation-status.md`.

## What a release is not

- It is not a hosted pipeline. There is no CI workflow; every check is a local script.
- It is not notarized. The app is self-signed with the owner's local identity, and installing on a second Mac is untested.
