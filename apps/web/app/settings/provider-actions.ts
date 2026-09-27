'use server';

import {
  type AddCatalogModelInput,
  addCatalogModel,
  addVoicePreset,
  chooseTextModels,
  chooseVoiceModel,
  type ProviderModelListing,
  removeModelConnection,
  type SaveModelConnectionInput,
  saveModelConnection,
  setModelConnectionEnabled,
  testModelConnection,
} from '@assistant/application/model-providers';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getModelProviderPorts } from '@/lib/server';

type ActionResult = { error?: string };

function done(result: { ok: true } | { ok: false; error: string }): ActionResult {
  if (!result.ok) return { error: result.error };
  revalidatePath('/settings');
  return {};
}

/** Connect a provider (or update one), then list its models so the owner can add some. */
export async function saveProviderConnectionAction(
  input: SaveModelConnectionInput,
): Promise<ActionResult & { id?: string; models?: ProviderModelListing[]; testError?: string }> {
  await requireOwner();
  const ports = getModelProviderPorts();
  const saved = await saveModelConnection(ports, input);
  if (!saved.ok) return { error: saved.error };
  const test = await testModelConnection(ports, saved.id);
  revalidatePath('/settings');
  return test.ok ? { id: saved.id, models: test.models } : { id: saved.id, testError: test.error };
}

export async function testProviderConnectionAction(
  id: string,
): Promise<ActionResult & { models?: ProviderModelListing[] }> {
  await requireOwner();
  const result = await testModelConnection(getModelProviderPorts(), id);
  revalidatePath('/settings');
  return result.ok ? { models: result.models } : { error: result.error };
}

export async function setProviderConnectionEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  await requireOwner();
  return done(await setModelConnectionEnabled(getModelProviderPorts(), id, enabled));
}

export async function removeProviderConnectionAction(id: string): Promise<ActionResult> {
  await requireOwner();
  return done(await removeModelConnection(getModelProviderPorts(), id));
}

export async function addProviderModelAction(input: AddCatalogModelInput): Promise<ActionResult> {
  await requireOwner();
  return done(await addCatalogModel(getModelProviderPorts(), input));
}

export async function chooseTextModelsAction(input: {
  mainModel: string;
  fastModel: string;
}): Promise<ActionResult> {
  await requireOwner();
  return done(await chooseTextModels(getModelProviderPorts(), input));
}

export async function addVoicePresetAction(input: {
  connectionId: string;
  model: string;
}): Promise<ActionResult> {
  await requireOwner();
  return done(await addVoicePreset(getModelProviderPorts(), input));
}

export async function chooseVoiceModelAction(modelId: string): Promise<ActionResult> {
  await requireOwner();
  return done(await chooseVoiceModel(getModelProviderPorts(), modelId));
}
