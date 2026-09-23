import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  application: {
    addSkill: vi.fn(),
    editSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillDeprecated: vi.fn(),
  },
  getApplication: vi.fn(),
  revalidate: vi.fn(),
  driver: 'postgres' as 'postgres' | 'firestore',
  mobileSkill: {
    write: vi.fn(),
    delete: vi.fn(),
    deprecate: vi.fn(),
  },
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({ getChatApplication: mocks.getApplication }));
vi.mock('@assistant/config', () => ({ loadConfig: () => ({ PERSISTENCE_DRIVER: mocks.driver }) }));
vi.mock('@/lib/mobile-skill-write', () => ({
  writeFirestoreMobileSkill: mocks.mobileSkill.write,
  deleteFirestoreMobileSkill: mocks.mobileSkill.delete,
  setFirestoreMobileSkillDeprecated: mocks.mobileSkill.deprecate,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

import {
  addSkillAction,
  deleteSkillAction,
  editSkillAction,
  toggleSkillDeprecatedAction,
} from './actions';

const id = '11111111-2222-4333-8444-555555555555';
const input = { name: 'Planning', preconditions: '', steps: 'Check the goal', gotchas: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.driver = 'postgres';
  mocks.owner.mockResolvedValue(undefined);
  mocks.getApplication.mockReturnValue(mocks.application);
  mocks.application.addSkill.mockResolvedValue({});
  mocks.application.editSkill.mockResolvedValue({});
  mocks.application.deleteSkill.mockResolvedValue(undefined);
  mocks.application.setSkillDeprecated.mockResolvedValue(undefined);
});

describe('owner Skills actions', () => {
  it('authenticates, delegates mutations to the configured application, and revalidates', async () => {
    await expect(addSkillAction(input)).resolves.toEqual({});
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.getApplication).toHaveBeenCalledOnce();
    expect(mocks.application.addSkill).toHaveBeenCalledWith(input);
    expect(mocks.revalidate).toHaveBeenCalledWith('/skills');

    await expect(editSkillAction(id, input)).resolves.toEqual({});
    expect(mocks.application.editSkill).toHaveBeenCalledWith(id, input);
    await deleteSkillAction(id);
    expect(mocks.application.deleteSkill).toHaveBeenCalledWith(id);
    await toggleSkillDeprecatedAction(id, true);
    expect(mocks.application.setSkillDeprecated).toHaveBeenCalledWith(id, true);
    expect(mocks.revalidate).toHaveBeenCalledTimes(4);
  });

  it('does not call the application when authentication or the skill id is invalid', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(addSkillAction(input)).rejects.toThrow('Unauthorized');
    expect(mocks.getApplication).not.toHaveBeenCalled();

    await expect(editSkillAction('bad-id', input)).resolves.toEqual({ error: 'Invalid skill.' });
    await deleteSkillAction('bad-id');
    await toggleSkillDeprecatedAction('bad-id', true);
    expect(mocks.application.editSkill).not.toHaveBeenCalled();
    expect(mocks.application.deleteSkill).not.toHaveBeenCalled();
    expect(mocks.application.setSkillDeprecated).not.toHaveBeenCalled();
  });

  it('uses the Firestore mobile write path for all mutations without touching the SQL application', async () => {
    mocks.driver = 'firestore';
    mocks.mobileSkill.write.mockResolvedValue(undefined);
    mocks.mobileSkill.delete.mockResolvedValue(undefined);
    mocks.mobileSkill.deprecate.mockResolvedValue(undefined);

    await expect(addSkillAction(input)).resolves.toEqual({});
    await expect(editSkillAction(id, input)).resolves.toEqual({});
    await deleteSkillAction(id);
    await toggleSkillDeprecatedAction(id, true);

    expect(mocks.mobileSkill.write).toHaveBeenNthCalledWith(1, input);
    expect(mocks.mobileSkill.write).toHaveBeenNthCalledWith(2, input, id);
    expect(mocks.mobileSkill.delete).toHaveBeenCalledWith(id);
    expect(mocks.mobileSkill.deprecate).toHaveBeenCalledWith(id, true);
    expect(mocks.getApplication).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledTimes(4);
  });
});
