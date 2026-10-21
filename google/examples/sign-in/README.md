# google/sign-in playground

Signs you in with your real Google account through `BrowserSignIn`, then reads
your Gmail profile with the token the callback stored.

## 1. Google Cloud setup (once)

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create
   a project and **enable the Gmail API** (APIs & Services → Library).
2. **OAuth consent screen**: choose *External*, fill in the required fields,
   add the scope `https://www.googleapis.com/auth/gmail.readonly`, and add your
   own address under **Test users**. While the app is in *Testing*, only test
   users can sign in.
3. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Under **Authorized redirect URIs** add exactly:

   ```
   http://localhost:8080/auth/google/callback
   ```

   That is `GOOGLE_SIGN_IN_PUBLIC_URL` + `/auth/google/callback`. Change both together if you
   use another port or address.

## 2. Configure

```bash
cp .env.example .env.local      # .env.local is gitignored
```

and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the OAuth client.

## 3. Run

```bash
telo run google/examples/sign-in
```

Open <http://localhost:8080>:

| URL | |
|---|---|
| `/auth/google` | Starts sign-in — redirects to Google's consent screen. |
| `/auth/google/callback` | Where Google sends you back. Stores the grant, then redirects to `/me`. |
| `/me` | Your Gmail profile (`emailAddress`, totals), fetched with the stored token. Before sign-in it answers 500 *No stored grant for key "default"*. |

Grants are kept in memory, so restarting means signing in again.

## Behind a public address

To test a real domain or a tunnel (ngrok, cloudflared, a runner session), set
`GOOGLE_SIGN_IN_PUBLIC_URL` to that origin, e.g. `GOOGLE_SIGN_IN_PUBLIC_URL=https://abc123.ngrok.app`, and
register `https://abc123.ngrok.app/auth/google/callback` in the OAuth client.
Nothing in the manifest changes. Google requires `https` for anything other
than `localhost`.
