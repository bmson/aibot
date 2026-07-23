export default function UnauthorizedPage() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Sign-in required</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        This dashboard is private. Sign in with the owner account to continue.
      </p>
    </div>
  );
}
