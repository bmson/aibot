import { AUDIT_SECTIONS, type AuditSection } from '@assistant/application/audit-investigation';
import { requireOwner } from '@/auth';
import { getAuditInvestigation } from '@/lib/audit-investigation';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const section = query.get('section') ?? undefined;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    (section && !AUDIT_SECTIONS.includes(section as AuditSection))
  )
    return Response.json({ error: 'Invalid audit request.' }, { status: 400 });
  try {
    const report = await getAuditInvestigation(id, {
      section: section as AuditSection | undefined,
      cursor: query.get('cursor') ?? undefined,
      limit: 20,
      entryId: query.get('entry') ?? undefined,
      field: query.get('field') ?? undefined,
      offset: query.has('offset') ? Number(query.get('offset')) : undefined,
    });
    if (!report) return Response.json({ error: 'Audit record not found.' }, { status: 404 });
    return Response.json(report, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="audit-${id}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid '))
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
