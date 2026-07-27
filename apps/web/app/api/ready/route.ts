import { getApplication } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const readiness = await getApplication().checkReadiness();
  return Response.json(readiness, {
    status: readiness.ready ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
