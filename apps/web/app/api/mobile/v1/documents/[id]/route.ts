import { isModuleEnabled, loadConfig } from '@assistant/config';
import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid document id' }, { status: 400 });
  try {
    await getApplication().deleteDocument(id);
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document could not be deleted.' },
      { status: 409 },
    );
  }
}
