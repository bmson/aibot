export default function UnauthorizedPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">401 — Sign-in required</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Authentication is not configured. Set AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET and AUTH_SECRET in
        the environment to enable Google sign-in.
      </p>
    </div>
  );
}
