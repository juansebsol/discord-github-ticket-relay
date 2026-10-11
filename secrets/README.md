# secrets/

Local-only credential files. Everything in this folder except this README is git-ignored.

| File | Contents |
|---|---|
| `sec.pem` | GitHub App private key (GitHub → your app → Private keys → Generate a private key). Rename the downloaded file to `sec.pem`. |

Restrict permissions on the server: `chmod 600 secrets/sec.pem`.
