# Live FreeAgent OAuth

Stage 5 connects Fido directly to the owner's production FreeAgent company. The implementation is intentionally read-only: it uses FreeAgent resource `GET` requests only. Creating explanations or uploading attachments remains gated behind later stages and explicit user confirmation.

## Registered application

Configure the application in the FreeAgent Developer Dashboard with:

- application URL: `https://fido.flair.london`
- redirect URI: `https://fido.flair.london/oauth/freeagent/callback`
- production API origin: `https://api.freeagent.com`

The redirect URI must match exactly. Firebase Hosting rewrites that path to the `freeAgentOAuthCallback` function in `europe-west1`.

## Security model

1. The signed-in Fido owner calls `startFreeAgentOAuth`.
2. The function creates 32 random bytes of OAuth state. Only its SHA-256 hash is stored, along with the owner UID and a ten-minute expiry.
3. FreeAgent redirects to the public callback with an authorization code and state.
4. The callback consumes the state once in a Firestore transaction, then exchanges the short-lived code server-to-server.
5. The callback verifies the account using `GET /v2/users/me` and `GET /v2/company` and retains only the small identity subset shown in Fido.
6. Access and refresh tokens are encrypted with AES-256-GCM using a separate Firebase secret before storage. Firestore rules expose neither connection documents nor OAuth state documents to browsers.
7. Access tokens are refreshed server-side after expiry. A failed authorization never replaces a working connection.
8. Disconnect deletes Fido's locally stored encrypted tokens. FreeAgent does not document a token-revocation endpoint, so the user may also remove Fido from FreeAgent's authorised applications if they want to revoke the grant at source.

Tokens and authorization codes must never be logged, returned to the browser, committed, or pasted into chat.

## Configure Firebase secrets

Run the following locally. Paste each value only into the Firebase CLI prompt:

```bash
npx firebase functions:secrets:set FIDO_V2_FREEAGENT_CLIENT_ID
npx firebase functions:secrets:set FIDO_V2_FREEAGENT_CLIENT_SECRET
```

Generate the independent token-encryption key without printing it or placing it in shell history:

```bash
openssl rand -base64 32 | npx firebase functions:secrets:set FIDO_V2_FREEAGENT_TOKEN_ENCRYPTION_KEY --data-file=-
```

## Functions

- `startFreeAgentOAuth`: authenticated owner-only callable that returns the FreeAgent approval URL.
- `freeAgentOAuthCallback`: public HTTP redirect target protected by single-use state.
- `getFreeAgentConnection`: returns only safe connection metadata.
- `verifyFreeAgentConnection`: performs read-only identity requests and exercises refresh handling.
- `disconnectFreeAgent`: deletes the locally stored connection and tokens.

## Validate and deploy

```bash
npm run lint
npm run typecheck
npm test
npm run emulators
npm --prefix functions run typecheck
npm --prefix functions test
npm --prefix functions run build
npx firebase deploy --only functions:startFreeAgentOAuth,functions:freeAgentOAuthCallback,functions:getFreeAgentConnection,functions:verifyFreeAgentConnection,functions:disconnectFreeAgent,hosting
```

After deployment, select **Connect live FreeAgent** in Fido, approve the application in FreeAgent, and confirm that Fido displays the intended company, user, and GBP company currency. Select **Check connection** to exercise a read-only API call and token refresh path.

Official references: [OAuth](https://dev.freeagent.com/docs/oauth), [users](https://dev.freeagent.com/docs/users), [company](https://dev.freeagent.com/docs/company), and [API introduction](https://dev.freeagent.com/docs/introduction).
