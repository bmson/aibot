const WRITE_METHODS = new Set(['insert', 'update', 'delete']);
const PRIVATE_WRITE_BYPASSES = new Set(['dialect', 'session']);

export const POSTGRES_SOURCE_WRITE_FENCED =
  'PostgreSQL source writes are fenced for cutover maintenance.';

/**
 * Guard the Drizzle connection used by an application process during a source
 * freeze. Reads continue through typed select/query APIs. Raw SQL and the raw
 * postgres.js client are closed because they cannot be classified safely here.
 */
export function withPostgresSourceWriteFence<T extends object>(database: T): T {
  function guard(target: object, databaseSurface = true): object {
    return new Proxy(target, {
      get(current, property) {
        if (databaseSurface && property === '$client') {
          const client = Reflect.get(current, property, current) as unknown;
          if (!client || (typeof client !== 'object' && typeof client !== 'function'))
            throw new Error(
              `${POSTGRES_SOURCE_WRITE_FENCED} Raw PostgreSQL access is unavailable.`,
            );
          return new Proxy(client as object, {
            get(rawClient, rawProperty) {
              if (rawProperty !== 'end')
                throw new Error(
                  `${POSTGRES_SOURCE_WRITE_FENCED} Raw PostgreSQL access is unavailable.`,
                );
              const end = Reflect.get(rawClient, rawProperty, rawClient);
              return typeof end === 'function'
                ? (...args: unknown[]) => Reflect.apply(end, rawClient, args)
                : end;
            },
          });
        }
        if (PRIVATE_WRITE_BYPASSES.has(String(property)))
          throw new Error(
            `${POSTGRES_SOURCE_WRITE_FENCED} Internal Drizzle access is unavailable.`,
          );
        if (WRITE_METHODS.has(String(property)))
          return () => {
            throw new Error(POSTGRES_SOURCE_WRITE_FENCED);
          };
        if (['execute', 'batch'].includes(String(property)))
          return () => {
            throw new Error(`${POSTGRES_SOURCE_WRITE_FENCED} Use typed read queries only.`);
          };

        const value = Reflect.get(current, property, current) as unknown;
        if (typeof value !== 'function') return wrap(value);
        if (databaseSurface && property === 'transaction') {
          return (callback: unknown, ...args: unknown[]) => {
            if (typeof callback !== 'function')
              throw new Error('PostgreSQL transaction callback must be a function');
            return Reflect.apply(value, current, [
              (transaction: object, ...callbackArgs: unknown[]) =>
                Reflect.apply(callback, undefined, [guard(transaction), ...callbackArgs]),
              ...args,
            ]);
          };
        }
        return (...args: unknown[]) => wrap(Reflect.apply(value, current, args));
      },
    });
  }

  function wrap(value: unknown): unknown {
    if (!value || typeof value !== 'object' || value instanceof Promise) return value;
    return guard(value, false);
  }

  return guard(database) as T;
}
