# Hosting on Vercel & Basic Authentication

If you do not have your own web server or hosting infrastructure, deploying to Vercel is the recommended solution. It allows you to host the Svelte 5 client-side application for free and easily secure it with password protection (Basic Authentication) using Edge Middleware.

---

## 🚀 Deployment Process (Without Custom Infrastructure)

To deploy SK Brickhouse to Vercel:
1. **Fork the Repository**: Fork this repository to your own GitHub account.
2. **Import to Vercel**:
   * Go to the Vercel Dashboard and click **Add New** > **Project**.
   * Import your forked repository.
3. **Configure Build Settings**:
   * Vercel will automatically detect the Vite + Svelte configuration.
   * **Build Command**: `npm run build` (This automatically runs the catalog generator script `generate-local-catalog.ts` to build the local JSON database from Rebrickable catalog dumps).
   * **Output Directory**: `dist`
4. **Deploy**: Click **Deploy**. Vercel will build the catalog and serve the SPA globally on its edge network.

---

## 🔒 Securing the App (Basic Authentication)

To prevent unauthorized access to your deployed scanner, the application includes an Edge Middleware ([middleware.ts](file:///Users/frank/repositories/brick-relic/middleware.ts)) that runs at the serverless edge on every request.

### How it works
1. The middleware checks for the presence of the `BASIC_AUTH_PASSWORD` environment variable.
2. If the variable is **not configured** (e.g. during local development), the middleware bypasses authentication, serving the app immediately.
3. If it **is configured**, it prompts users for a password (the username can be left empty or set to any value) using the browser's native Basic Auth login box.

### Configuration on Vercel
To enable this password protection on your Vercel deployment:
1. Open your project on the **Vercel Dashboard**.
2. Go to **Settings** > **Environment Variables**.
3. Add a new environment variable:
   * **Key**: `BASIC_AUTH_PASSWORD`
   * **Value**: *[Your desired password]*
4. Click **Save** and trigger a redeployment (or push a new commit) for the changes to take effect.
