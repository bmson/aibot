export default function UnauthorizedPage() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-lg font-semibold text-strong">Sign-in required</h1>
      <p className="mt-2 text-sm text-muted">
        This dashboard is private. Sign in with the owner account to continue.
      </p>
    </div>
  );
}
