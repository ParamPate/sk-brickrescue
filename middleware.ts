// Vercel Edge Middleware: optional Basic Auth for preview/staging deployments
// (see docs/VERCEL.md). Skips static catalog data and build assets so the large
// JSON downloads do not invoke the edge function on every request.
export const config = {
  matcher: ["/((?!catalog/|assets/|fonts/|favicon\\.svg|logo\\.svg).*)"],
};

// Constant-time comparison via SHA-256 digests: digest length is fixed, so the
// byte-wise XOR loop leaks no timing information about the expected password.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

export default async function middleware(request: Request) {
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD;
  if (!expectedPassword) {
    // If BASIC_AUTH_PASSWORD is not set (e.g. locally or in self-hosted Docker),
    // bypass authentication and serve the app.
    return;
  }

  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    const [type, credentials] = authHeader.split(" ");
    if (type === "Basic" && credentials) {
      try {
        // Decode base64 credentials (username:password). RFC 7617 allows colons
        // inside the password, so only the first colon separates the username.
        const decoded = atob(credentials);
        const separator = decoded.indexOf(":");
        const password = separator === -1 ? "" : decoded.slice(separator + 1);

        if (await timingSafeEqual(password, expectedPassword)) {
          // Authentication successful
          return;
        }
      } catch {
        // Base64 decoding failed
      }
    }
  }

  // If unauthorized, return 401 and request Basic Auth credentials
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="BrickRelic Secure Area"',
    },
  });
}
