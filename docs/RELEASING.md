# Releasing to Google Play (internal testing)

Updates reach testers through Play's **internal testing** track. The workflow
`.github/workflows/play-internal.yml` builds a signed bundle from `main` and uploads it there. It
is started by hand, from the repository's default branch only.

The track is fixed to `internal` in `scripts/play/publish-internal.mjs`, the copy on the default
branch. The service account's Play permission ("release to testing tracks") also covers the closed
and open testing tracks. So the secrets must only be usable from the default branch; see the
environment below. Production is never possible: the service account has no production rights.

## Running it

Go to **Actions → Play internal release → Run workflow**, with the branch set to the default
branch. The job always builds `main`, whatever branch the workflow file sits on.

| Input | Meaning |
|---|---|
| What's new | Optional release note for testers, up to 500 characters. It is checked before anything is built. |
| Version name | For example `0.15.1`. The default is `versionName` in `android/app/build.gradle` on `main`. If `main`'s `versionCode` is behind Play (under 16), the run stops and asks for a name, so a release never goes backwards. |
| Lowest version code | Leave empty. Only needed if Play ever says a version code "has already been used". |
| Dry run | Builds, signs and checks the bundle without uploading it. |

The run has three jobs, each on a fresh runner:

1. **plan** checks that the run started from the default branch and that the inputs are valid. It
   then asks Play for the highest version code it has seen, in any track or any uploaded bundle,
   and picks one above it, never below 16 and never below `main`'s `versionCode`.
2. **build** runs the unit tests and builds the unsigned bundle from that exact `main` commit. It
   sees no secrets. It also checks the Gradle wrapper. Before the web build it asks Vite which
   `VITE_*` settings it would use, and it stops if there are any. That keeps sign-in, cloud saves and
   versus switched off.
3. **publish** checks that the bundle is unsigned, then signs it with the upload key. Before signing,
   it checks that the keystore holds the registered upload certificate. Afterwards it requires
   exactly one signature, made by that certificate. It runs `bundletool validate` and checks the
   package, version code and version name. Then, unless it is a dry run, it uploads the bundle,
   makes it the internal track's release, and commits.

The commit uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW`. If something else is in review at
Play, such as a store listing change, the run fails with Google's message instead of cancelling
that review. Run it again once the review is finished.

The signed `.aab` is kept as a run artifact for 30 days. The repository is public, so run logs and
artifacts are public too. Neither contains a secret.

## Secrets and the `play-internal` environment

The `plan` and `publish` jobs run in the GitHub environment **`play-internal`**.

1. Go to **Settings → Environments → New environment** and name it `play-internal`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only the
   default branch.
3. Optionally, add a required reviewer. Each run then asks for approval twice, once for plan and
   once for publish.
4. Add these as **environment secrets** there, and delete any repository-level copies. Repository
   secrets can be read by workflows on every branch.

| Secret | Value |
|---|---|
| `PLAY_SERVICE_ACCOUNT_JSON` | The service account's JSON key. The account has Play Console access to `com.wildhaven.zoo`, with release rights to testing tracks only. |
| `WILDHAVEN_UPLOAD_KEYSTORE_BASE64` | The upload keystore file (`wildhaven-upload.jks`), base64-encoded on one line. |
| `WILDHAVEN_UPLOAD_STORE_PASSWORD` | The keystore password. |
| `WILDHAVEN_UPLOAD_KEY_ALIAS` | The key alias (`upload`). |
| `WILDHAVEN_UPLOAD_KEY_PASSWORD` | The key password. The keystore is PKCS12, so this is the same as the keystore password. |

The workflow also works with repository secrets, but then only the default-branch check stands
between another branch and the secrets.

The upload certificate's SHA-256 is pinned in the workflow:
`46:9B:8B:96:AC:D2:0D:DB:DD:6B:28:73:7A:CC:E7:4A:5E:CD:2B:01:85:38:76:C6:4F:A1:DC:92:6F:BC:1B:8E`.
A keystore holding any other certificate stops the run before anything is signed. If the upload key
is ever reset in Play Console, update `UPLOAD_CERT_SHA256` in the workflow.

## Version numbers

Play rejects a version code it has already seen, and phones only update to a higher one. The plan
job handles the version code itself. Keep `versionName` (and `versionCode`) in
`android/app/build.gradle` current on `main`, or type a version name when starting the run.
