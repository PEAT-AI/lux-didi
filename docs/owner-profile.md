# Protected owner profile

An owner profile is optional, private presentation context: authored style and background lore. It is not a new account, a replacement authority policy or permission to read more memory. The public assistant is Naya; a configured display name does not replace the stored assistant identity.

## Select a file explicitly

The host's `--owner-profile` option selects one file. Without it, `loadOwnerProfile` in `server/config/owner-profile.ts` returns `publicOwnerProfile`. There is no profile discovery or hot reload. Restart deliberately to load a changed file for new acceptances; an existing accepted run must not silently change character underneath its recorded instruction.

For an installed application, use the protected configuration selection described in [macos-install.md](macos-install.md). Keep real profile text outside the repository and application bundle.

The loader uses `validateRoot` and `readPrivate` from `server/config/files.ts`: the parent directory and file must meet the protected ownership, type and permission rules. An explicitly selected unsafe or invalid profile reports an error rather than silently falling back to the public character.

## Authoring contract

`validateOwnerProfile` in `server/prompt/index.ts` owns the closed schema. Read it before authoring or changing a profile. It binds the profile to the local owner and validates its version, display name, style and lore. Use that schema rather than a copied example that may drift from the validator.

Style and lore each carry a data class. `ownerProfileClasses` contributes those classes to provider disclosure policy; system-text placement does not make private content ordinary. Classify conservatively and never use an authored paragraph to claim extra tools, grants or source availability.

The host composes its canonical runtime rules around the authored sections. Oversized instructions fail rather than truncating required authority rules. [prompt-composition.md](prompt-composition.md) owns prompt assembly; [privacy-and-authority.md](privacy-and-authority.md) owns class and consent enforcement.

## Accepted runs and public status

`ChatService` in `server/chat/index.ts` stores the selected profile in `chat_run_owner_profile` at acceptance. Dispatch must use the accepted snapshot, not reread the mutable file. Live acceptance is owned by `server/live/index.ts`; changing a current profile is not permission to open an old session with invented instructions.

The public `ownerProfile` projection is status and display information, not an export of authored text. Keep profile paths, lore, private versions and accepted instruction content out of status, errors and diagnostic receipts. An active profile proves neither provider readiness nor that a model will follow its style exactly.
