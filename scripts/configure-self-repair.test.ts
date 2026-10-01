import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('requires destination approval and mounts hosted credentials only on the agent without command arguments or logs', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import importlib.util, io, json, types, sys
sys.dont_write_bytecode=True
from contextlib import redirect_stdout
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('repair_setup','scripts/configure-self-repair.py')
setup=importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
with patch('builtins.input', return_value=''), patch.object(setup,'run') as run, patch.object(setup.getpass,'getpass') as prompt:
    try: setup.configure_hosted()
    except SystemExit: pass
    else: raise AssertionError('Missing approval must stop setup')
    run.assert_not_called()
    prompt.assert_not_called()
calls=[]
coding='sk-'+'synthetic-coding'
publisher='github_'+'pat_synthetic-publisher'
def run(args, **kwargs):
    calls.append((args,kwargs))
    if args[:4]==['gcloud','run','services','describe']:
        return types.SimpleNamespace(returncode=0,stdout=json.dumps({'spec':{'template':{'spec':{'serviceAccountName':'runtime@example.test'}}}}))
    return types.SimpleNamespace(returncode=0,stdout='')
out=io.StringIO()
with redirect_stdout(out), patch('builtins.input',return_value='HOSTED'), patch.object(setup.Path,'is_symlink',return_value=False), patch.object(setup.Path,'is_file',return_value=True), patch.object(setup.Path,'read_text',return_value='OPENAI_API_KEY='+coding), patch.object(setup.getpass,'getpass',return_value=publisher), patch.object(setup,'github',return_value={'full_name':setup.SOURCE,'private':False}), patch.object(setup,'run',side_effect=run):
    setup.configure_hosted()
for args,kwargs in calls:
    assert coding not in ' '.join(args) and publisher not in ' '.join(args)
assert coding not in out.getvalue() and publisher not in out.getvalue()
updates=[args for args,_ in calls if args[:4]==['gcloud','run','services','update']]
assert len(updates)==2
agent=next(a for a in updates if a[4]=='assistant-agent')
web=next(a for a in updates if a[4]=='assistant-web')
assert any('SELF_REPAIR_OPENAI_API_KEY=' in a and 'SELF_REPAIR_GITHUB_TOKEN=' in a for a in agent)
assert not any('--update-secrets' in a for a in web)
assert all(any('SELF_REPAIR_ENABLED=false' in a for a in args) for args in updates)
versions=[(args,kwargs) for args,kwargs in calls if args[:4]==['gcloud','secrets','versions','add']]
assert len(versions)==2 and {kwargs['secret_input'] for _,kwargs in versions}=={coding,publisher}
assert not any(args[0]=='gh' for args,_ in calls)
print('Hosted setup verified')
`,
    ],
    { encoding: 'utf8' },
  );
  expect(result).toContain('Hosted setup verified');
});
