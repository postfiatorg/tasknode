import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const script = path.resolve('public/l1-validator.sh');
assert.equal(spawnSync('sh', ['-n', script]).status, 0);
const help = spawnSync('sh', ['-s', '--', '--help'], { input: readFileSync(script), encoding: 'utf8' });
assert.equal(help.status, 0, help.stderr); assert.ok(help.stdout.includes('Usage:'));
const result = spawnSync('python3', ['-', script], { encoding: 'utf8', input: String.raw`
import contextlib, fcntl, hashlib, io, json, os, pathlib, sys
from types import SimpleNamespace
from unittest.mock import patch
source = pathlib.Path(sys.argv[1]).read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
source = source.split('\ntry:\n    main()')[0]
ns = {}; exec(compile(source, 'l1-validator.sh', 'exec'), ns)
assert ns['HELPER_SHA256'] == '63c5e3d56556447dc06cbcd9fd0b4d8e620dc17068166bb51d3cdb41f50f6eca'
base = ns['BASE']; helper_url = ns['HELPER_URL']; helper = b'SYNTHETIC-HELPER-NO-PRIVATE-MATERIAL'
ns['HELPER_SHA256'] = hashlib.sha256(helper).hexdigest()
token = 'vct_' + 'a' * 64
challenge = 'pf-tasknode:' + 'b' * 64 + ':account-fixture:1900000000'
proof = {'validator_id':'validator-0', 'ml_dsa_public_key':'a'*3904, 'signature':'b'*6618}

def run(mode='ok', argv=None):
    calls=[]; reads=[]; isolated=[]; output=io.StringIO(); errors=io.StringIO()
    def read_bytes(p):
        reads.append(str(p)); assert str(p).endswith('/cmdline'), 'no secret file read by wrapper'
        key='/existing/key.json' if str(p).startswith('/proc/10/') else '/other/key.json'
        return ('/opt/postfiat-node\0transport-validator-serve\0--key-file\0'+key+'\0--data-dir\0/data/node\0').encode()
    def read_text(p, *args, **kwargs):
        reads.append(str(p)); assert str(p) == '/data/node/node_state.json'
        return '{"node_id":"validator-0"}\nappended-MAC'
    def request(url, payload=None, limit=0):
        calls.append((url,payload))
        if url == helper_url: return b'wrong' if mode=='hash' else helper
        if url == base+'/api/validators/connect/challenge':
            assert payload == {'token':token}
            return json.dumps({'challenge':'malicious\nmessage' if mode=='challenge' else challenge}).encode()
        assert url == base+'/api/validators/connect/complete'
        assert payload == {'token':token,'network':'l1-devnet',**proof}
        return b'{"ok":true}'
    def subprocess_run(args, **kwargs):
        assert args[:3] == ['unshare','--net','--']
        if args[3] == 'true': return SimpleNamespace(returncode=1 if mode=='isolation' else 0)
        isolated.append(args)
        assert args[4:] == ['--key-file','/existing/key.json','--validator-id','validator-0']
        assert kwargs['input'] == challenge.encode() and kwargs['timeout']==30
        fd=kwargs['pass_fds'][0]; assert args[3] == '/proc/self/fd/'+str(fd)
        assert pathlib.Path(args[3]).read_bytes() == helper
        assert fcntl.fcntl(fd, fcntl.F_GET_SEALS) & fcntl.F_SEAL_WRITE
        result=dict(proof)
        if mode=='proof': result['private_key']='must-not-leave'
        return SimpleNamespace(returncode=1 if mode=='signing' else 0, stdout=json.dumps(result).encode())
    ns['request']=request
    # Allow the memfd inspection through the real reader; all proc discovery reads are synthetic.
    real_read=pathlib.Path.read_bytes
    def controlled_read(p):
        return real_read(p) if str(p).startswith('/proc/self/fd/') else read_bytes(p)
    exit_code=0
    names=[] if mode=='missing' else ['/proc/10/cmdline','/proc/11/cmdline'] if mode=='ambiguous' else ['/proc/10/cmdline']
    with patch.object(sys,'argv',['script',*(argv or [token])]), patch.object(ns['glob'],'glob',return_value=names), \
        patch.object(pathlib.Path,'read_bytes',controlled_read), patch.object(pathlib.Path,'read_text',read_text), \
        patch.object(ns['subprocess'],'run',side_effect=subprocess_run), patch.object(ns['platform'],'machine',return_value='arm64' if mode=='platform' else 'x86_64'), \
        patch.object(ns['platform'],'system',return_value='Linux'), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
        try: ns['main']()
        except SystemExit as e: exit_code=e.code
    assert token not in errors.getvalue() and 'must-not-leave' not in errors.getvalue()+output.getvalue()
    return exit_code, calls, isolated, output.getvalue(), errors.getvalue(), reads
ok=run(); assert ok[0]==0 and len(ok[1])==3 and len(ok[2])==1 and ok[3].startswith('Validator connected:')
discovery=run(argv=['--discover']); assert discovery[0]==0 and discovery[1]==[] and discovery[2]==[]
assert json.loads(discovery[3])=={'validator_id':'validator-0','configured_key_path':'/existing/key.json'}
for mode in ['platform','missing','ambiguous','isolation','hash','challenge','signing','proof']:
    result=run(mode); assert result[0]!=0, mode
    assert not any(url.endswith('/complete') for url,payload in result[1]), mode
    if mode in ['platform','missing','ambiguous','isolation']: assert result[1]==[], mode
try: ns['NoRedirect']().redirect_request(None,None,None,None,None,None)
except ValueError: pass
else: raise AssertionError('redirect allowed')
print('l1-validator-shell-smoke ok: piped help, exact running process discovery, no secret reads, explicit isolation, pinned sealed memfd, exact challenge/public proof, safe failures, no redirect')
` });
assert.equal(result.status, 0, result.stderr); process.stdout.write(result.stdout);
