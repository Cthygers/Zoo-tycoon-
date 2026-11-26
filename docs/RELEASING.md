# Releasing to Google Play (internal testing)

Updates reach testers through Play's **internal testing** track. The workflow
`.github/workflows/play-internal.yml` builds a signed bundle from `main` and uploads it there. It
is started by hand, and it cannot release to the alpha, beta or production tracks: the track is
fixed in `scripts/play/publish-internal.mjs`.

## Running it

Go to **Actions → Play internal release → Run workflow**. Run it from the repository's default
branch: the job always builds `main`, whatever branch the workflow runs from.

| Input | Meaning |
|---|---|
| What's new | Optional release note for testers, up to 500 characters. |
| Version name | Optional. The default is `versionName` in `android/app/build.gradle` on `main`. |
| Dry run | Builds, signs and checks the bundle without uploading it. |

The run has three jobs, each on a fresh runner:

1. **plan** asks Play for the highest version code it has seen, in any track or any uploaded
   bundle. It picks one above it, never below 16 and never below `main`'s `versionCode`.
2. **build** runs the unit tests and builds the unsigned bundle from `main`. It sees no secrets.
   No `VITE_*` setting is passed, so sign-in, cloud saves and versus stay off.
3. **publish** signs the bundle with the upload key and checks that the signer is the registered
   upload certificate. It then runs `bundletool validate` and checks the package, version code and
   version name. Unless it is a dry run, it uploads the bundle, makes it the internal track's
   release and commits the change. The signed `.aab` is also kept as a run artifact for 30 days.

## Secrets (repository → Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `PLAY_SERVICE_ACCOUNT_JSON` | The JSON key of a service account that has Play Console access to `com.wildhaven.zoo`, with release rights to testing tracks only. |
| `WILDHAVEN_UPLOAD_KEYSTORE_BASE64` | The upload keystore file (`wildhaven-upload.jks`), base64-encoded on one line. |
| `WILDHAVEN_UPLOAD_STORE_PASSWORD` | The keystore password. |
| `WILDHAVEN_UPLOAD_KEY_ALIAS` | The key alias (`upload`). |
| `WILDHAVEN_UPLOAD_KEY_PASSWORD` | The key password. The keystore is PKCS12, so this is the same as the keystore password. |

The upload certificate's SHA-256 is pinned in the workflow:
`46:9B:8B:96:AC:D2:0D:DB:DD:6B:28:73:7A:CC:E7:4A:5E:CD:2B:01:85:38:76:C6:4F:A1:DC:92:6F:BC:1B:8E`.
A keystore with any other certificate stops the run before anything is signed. If the upload key
is ever reset in Play Console, update `UPLOAD_CERT_SHA256` in the workflow.

## Version numbers

Play rejects a version code it has already seen, and phones only update to a higher one. The plan
job handles this by itself. Keep `versionName` in `android/app/build.gradle` current on `main`, or
type a version name when starting the run.
