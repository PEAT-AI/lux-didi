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

## The people roster beside the profile

`people.json` sits in the same directory as the active owner profile; the host reads it once at start, with the profile directory's own resolution and the same `validateRoot` and `readPrivate` rules. It is the owner's own list of the people Naya should know at every call start, and it is the only source the people resolver may bind on.

```json
{ "version": 1,
  "people": [
    { "id": "ravi-example", "name": "Ravi Example", "aliases": ["Ravi", "Robby"],
      "role": "head of sales India", "circle": "plantix", "project": "",
      "tier": 1, "email": ["ravi.example@example.test"], "mattermost": "ravi.e", "note": "" } ] }
```

`id` is a stable unique slug, `name` the canonical display name, `aliases` the curated first names, nicknames and speech-to-text forms, `circle` one of `plantix`, `helm`, `external`, `family`, `friend` or `project`, `tier` 1 for a full instruction line or 2 for name and role only, `email` and `mattermost` the handles a connector may act on, and `note` an optional hint of at most 80 characters. The schema is strict: an unknown key, a duplicate id or a malformed value rejects the whole file, the host logs `people_invalid` with its reason, and no roster is loaded rather than a partial one.

A tier 1 line renders as `Name (aliases) - role - circle/project - email local part - @mattermost`; a tier 2 line as `Name - role`; the order is the file's own. The section has its own `PEOPLE_CHAR_LIMIT` and drops tier 2 lines from the end first, logging the count in `people_trimmed`; the total instruction still answers to `LIVE_INSTRUCTION_HARD_LIMIT`. A spoken name binds only on an exact folded name, alias or handle: two people sharing one is a question naming both, and a name outside the roster falls through to the connector's own search. All identities above are synthetic.
