/**
 * pnpm setup:phone — give the deployed assistant a phone number.
 *
 * Run it yourself, once, in a terminal signed in to gcloud. It:
 *   1. asks for your Twilio Account SID and Auth Token (hidden) and checks them,
 *   2. stores the token in Secret Manager for the agent (never in a file or env var),
 *   3. uses a number you already rent, or finds one and buys it only after you type "y",
 *   4. points the number's call and SMS webhooks at the agent,
 *   5. updates the agent (and web) service: Twilio settings, your own number,
 *      the calls module, a one-hour request timeout for live calls, and — if you
 *      want Gemini Live voice — Vertex AI access.
 *
 * Nothing here is sent anywhere but Twilio and your own Google Cloud project.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROJECT = process.env.GCP_PROJECT || gcloud(['config', 'get-value', 'project']).trim();
const REGION = process.env.GCP_REGION || 'us-west1';
const AGENT = 'assistant-agent';
const WEB = 'assistant-web';

function gcloud(args: string[], input?: string): string {
  const result = spawnSync('gcloud', args, { input, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

function ask(question: string, fallback = ''): Promise<string> {
  return new Promise((resolve) =>
    rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, (answer) =>
      resolve(answer.trim() || fallback),
    ),
  );
}

/** Read a secret without echoing it to the terminal. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const output = rl as unknown as {
      _writeToOutput?: (text: string) => void;
      output: NodeJS.WriteStream;
    };
    const original = output._writeToOutput;
    output._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(`${question}: `, (answer) => {
      output._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = (await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return answer ? answer === 'y' || answer === 'yes' : defaultYes;
}

function twilio(sid: string, token: string) {
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  return async <T>(url: string, form?: Record<string, string>): Promise<T> => {
    const response = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        authorization: auth,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok)
      throw new Error(`Twilio ${response.status}: ${body.message ?? 'request failed'}`);
    return body;
  };
}

function serviceEnv(service: string): Record<string, string> {
  const json = JSON.parse(
    gcloud([
      'run',
      'services',
      'describe',
      service,
      '--region',
      REGION,
      '--project',
      PROJECT,
      '--format=json',
    ]),
  ) as {
    status?: { url?: string };
    spec: {
      template: {
        spec: {
          serviceAccountName?: string;
          containers: Array<{ env?: Array<{ name: string; value?: string }> }>;
        };
      };
    };
  };
  const env: Record<string, string> = {};
  for (const entry of json.spec.template.spec.containers[0]?.env ?? [])
    if (entry.value !== undefined) env[entry.name] = entry.value;
  env.__URL = json.status?.url ?? '';
  env.__SA = json.spec.template.spec.serviceAccountName ?? '';
  return env;
}

async function main() {
  console.log(`\nPhone setup for project ${PROJECT} (${REGION}).\n`);
  const agentEnv = serviceEnv(AGENT);
  const webEnv = serviceEnv(WEB);
  const agentUrl = agentEnv.PUBLIC_URL || agentEnv.__URL;
  if (!agentUrl) throw new Error('Could not read the agent service URL.');

  console.log(
    'You need a Twilio account (twilio.com). Find the Account SID and Auth Token on the Console home page.',
  );
  const sid = await ask('Twilio Account SID (starts with AC)', agentEnv.TWILIO_ACCOUNT_SID ?? '');
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error('That is not an Account SID.');
  const token = await askHidden('Twilio Auth Token (hidden)');
  if (!/^[0-9a-f]{32}$/i.test(token))
    throw new Error('That is not an Auth Token (32 hex characters).');
  const api = twilio(sid, token);
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const account = await api<{ friendly_name: string; status: string; type: string }>(
    `${base}.json`,
  );
  console.log(`✓ Twilio account "${account.friendly_name}" (${account.type}, ${account.status})`);
  if (account.type === 'Trial')
    console.log(
      '  ! Trial accounts can only call numbers you have verified, and play a trial notice first. Upgrade in the Twilio Console to call businesses.',
    );

  // 1. The token goes to Secret Manager, readable only by the agent.
  const secrets = gcloud(['secrets', 'list', '--project', PROJECT, '--format=value(name)']);
  if (secrets.split('\n').some((name) => name.trim() === 'twilio-auth-token'))
    gcloud(
      ['secrets', 'versions', 'add', 'twilio-auth-token', '--project', PROJECT, '--data-file=-'],
      token,
    );
  else
    gcloud(
      [
        'secrets',
        'create',
        'twilio-auth-token',
        '--project',
        PROJECT,
        '--replication-policy=automatic',
        '--data-file=-',
      ],
      token,
    );
  if (agentEnv.__SA)
    gcloud([
      'secrets',
      'add-iam-policy-binding',
      'twilio-auth-token',
      '--project',
      PROJECT,
      `--member=serviceAccount:${agentEnv.__SA}`,
      '--role=roles/secretmanager.secretAccessor',
      '--quiet',
    ]);
  console.log('✓ Auth Token stored in Secret Manager (twilio-auth-token)');

  // 2. A number: one you already rent, or a new one after you confirm the price.
  const owned = await api<{
    incoming_phone_numbers: Array<{
      sid: string;
      phone_number: string;
      capabilities: { voice: boolean; sms: boolean };
    }>;
  }>(`${base}/IncomingPhoneNumbers.json?PageSize=50`);
  const voiceNumbers = owned.incoming_phone_numbers.filter((n) => n.capabilities.voice);
  let number: { sid: string; phone_number: string } | undefined;
  if (voiceNumbers.length) {
    console.log('\nNumbers you already rent that can make calls:');
    for (const [i, n] of voiceNumbers.entries()) console.log(`  ${i + 1}. ${n.phone_number}`);
    const pick = await ask('Use which? (number, or "new" to buy another)', '1');
    if (pick !== 'new') number = voiceNumbers[Number(pick) - 1];
  }
  if (!number) {
    const areaCode = await ask('Area code for a new US number', '415');
    const available = await api<{
      available_phone_numbers: Array<{ phone_number: string; locality: string; region: string }>;
    }>(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${encodeURIComponent(areaCode)}&VoiceEnabled=true&SmsEnabled=true&PageSize=5`,
    );
    const candidate = available.available_phone_numbers[0];
    if (!candidate)
      throw new Error(`No voice numbers available in area code ${areaCode}; try another.`);
    const pricing = await api<{
      phone_number_prices: Array<{ number_type: string; current_price: string }>;
    }>('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US').catch(() => ({
      phone_number_prices: [],
    }));
    const monthly = pricing.phone_number_prices.find(
      (p) => p.number_type === 'local',
    )?.current_price;
    console.log(
      `\nAvailable: ${candidate.phone_number} (${candidate.locality}, ${candidate.region}) — ${monthly ? `$${monthly}/month` : 'see twilio.com/en-us/voice/pricing/us'}, charged to your Twilio account.`,
    );
    if (!(await confirm('Buy this number?'))) throw new Error('Stopped before buying a number.');
    number = await api<{ sid: string; phone_number: string }>(`${base}/IncomingPhoneNumbers.json`, {
      PhoneNumber: candidate.phone_number,
    });
    console.log(`✓ Bought ${number.phone_number}`);
  }

  // 3. Webhooks: callbacks to the number reach the agent.
  await api(`${base}/IncomingPhoneNumbers/${number.sid}.json`, {
    VoiceUrl: new URL('/webhooks/twilio/voice', agentUrl).toString(),
    VoiceMethod: 'POST',
    SmsUrl: new URL('/webhooks/twilio/sms', agentUrl).toString(),
    SmsMethod: 'POST',
  });
  console.log('✓ Call and SMS webhooks point at the agent');

  // 4. Service configuration.
  const ownerPhone = await ask(
    'Your own mobile number, for check-ins and approvals (E.164, e.g. +14155550123)',
    agentEnv.OWNER_PHONE ?? '',
  );
  if (ownerPhone && !/^\+[1-9]\d{6,14}$/.test(ownerPhone))
    throw new Error('Use E.164 form, like +14155550123.');
  const webUrl = await ask(
    'Your dashboard URL (for links in check-ins)',
    agentEnv.WEB_URL || webEnv.AUTH_URL || webEnv.__URL,
  );
  const modules = new Set(
    (agentEnv.ASSISTANT_MODULES || 'all')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  );
  if (!modules.has('all')) modules.add('calls');
  const vertex = await confirm(
    'Allow Gemini Live (Google Vertex AI) as a voice model? It bills to this project.',
    true,
  );
  const vertexLocation = 'us-central1';

  const env = [
    `TWILIO_ACCOUNT_SID=${sid}`,
    `TWILIO_FROM_NUMBER=${number.phone_number}`,
    `TWILIO_VOICE_FROM_NUMBER=${number.phone_number}`,
    ...(ownerPhone ? [`OWNER_PHONE=${ownerPhone}`] : []),
    ...(webUrl ? [`WEB_URL=${webUrl}`] : []),
    `ASSISTANT_MODULES=${[...modules].join(',')}`,
    ...(vertex && !agentEnv.VERTEX_PROJECT
      ? [`VERTEX_PROJECT=${PROJECT}`, `VERTEX_LOCATION=${vertexLocation}`]
      : []),
  ];
  if (vertex) {
    gcloud(['services', 'enable', 'aiplatform.googleapis.com', '--project', PROJECT]);
    if (agentEnv.__SA)
      gcloud([
        'projects',
        'add-iam-policy-binding',
        PROJECT,
        `--member=serviceAccount:${agentEnv.__SA}`,
        '--role=roles/aiplatform.user',
        '--condition=None',
        '--quiet',
      ]);
    console.log('✓ Vertex AI enabled for the agent');
  }
  console.log(
    '\nUpdating the agent service (a new revision; live traffic moves when it is healthy)…',
  );
  gcloud([
    'run',
    'services',
    'update',
    AGENT,
    '--region',
    REGION,
    '--project',
    PROJECT,
    `--update-env-vars=^|^${env.join('|')}`,
    '--update-secrets=TWILIO_AUTH_TOKEN=twilio-auth-token:latest',
    '--timeout=3600',
    '--quiet',
  ]);
  // The web app shows Calls only when the module is on, and offers the Vertex
  // voice presets only when Vertex is configured.
  const webUpdates = [
    `ASSISTANT_MODULES=${[...modules].join(',')}`,
    ...(vertex && !webEnv.VERTEX_PROJECT
      ? [`VERTEX_PROJECT=${PROJECT}`, `VERTEX_LOCATION=${vertexLocation}`]
      : []),
  ];
  console.log('Updating the web service…');
  gcloud([
    'run',
    'services',
    'update',
    WEB,
    '--region',
    REGION,
    '--project',
    PROJECT,
    `--update-env-vars=^|^${webUpdates.join('|')}`,
    '--quiet',
  ]);
  console.log(`\n✓ Done. The assistant's number is ${number.phone_number}.`);
  console.log(
    'Next: in the app, Settings → AI providers → Voice model, add and choose a voice model.',
  );
  console.log('Then ask the assistant in chat to call your own phone to try it.');
  if (!modules.has('all'))
    console.log(
      `\nKeep CI in step: gh variable set ASSISTANT_MODULES --body "${[...modules].join(',')}"`,
    );
}

main()
  .catch((error) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
