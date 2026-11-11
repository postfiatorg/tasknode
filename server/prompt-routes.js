import { getTerminalSessionByToken } from './repositories/terminal-auth.js';
import { registerPromptDevice, listPromptDevices, approvePromptDevice, revokePromptDevice, authorizePromptDevice } from './repositories/prompt-devices.js';
import { query, transaction } from './db/pool.js';
import { validPromptEnvelope, promptUuid, promptFailure } from './repositories/prompt-history.js';
import { appendPromptEvent, getPromptKey, initializePromptKey, listPromptEvents } from './repositories/prompt-history.js';

export async function handlePromptRoute({ req, res, url, session, json, readJson }) {
  if (!url.pathname.startsWith('/api/docs/prompts/')) return false;
  if (process.env.TASKNODE_DOCS_ENABLED === 'false') { json(res,503,{ok:false,error:'docs_disabled'}); return true; }
  const bearer = String(req.headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  const terminal = bearer ? await getTerminalSessionByToken(bearer) : null;
  if (bearer) session = terminal;
  if (!session?.accountId) { json(res,401,{ok:false,error:'docs_prompt_login_required'}); return true; }
  const accountId = session.accountId;
  let result;
  try {
    const endpoint = url.pathname.slice('/api/docs/prompts/'.length);
    const deviceId = String(req.headers['x-prompt-device'] || '');
    if (bearer) {
      if (!terminal) { json(res,401,promptFailure('device_login_required',401)); return true; }
      if (endpoint === 'devices' && req.method === 'POST') {
        result = await registerPromptDevice(accountId, terminal.id, await readJson(req,10000));
      } else {
        const envelope = await authorizePromptDevice(accountId, terminal.id, deviceId);
        if (!envelope) { json(res,403,promptFailure('device_approval_required',403)); return true; }
        if (endpoint === 'device-key' && req.method === 'GET') result = {ok:true,envelope};
        if (!['device-key','history','documents','config'].includes(endpoint)) { json(res,403,promptFailure('browser_required',403)); return true; }
      }
    } else if (endpoint === 'devices') {
      if (req.method === 'GET') result = await listPromptDevices(accountId);
      if (req.method === 'POST') { json(res,403,promptFailure('terminal_required',403)); return true; }
    } else if (endpoint === 'devices/approve' && req.method === 'POST') {
      const body = await readJson(req,10000);
      result = await approvePromptDevice(accountId,body.deviceId,body.envelope);
    } else if (endpoint === 'devices/revoke' && req.method === 'POST') {
      result = await revokePromptDevice(accountId,(await readJson(req,10000)).deviceId);
    }
    if (endpoint === 'config' && req.method === 'GET') result = {ok:true,pfdocsOrigin:process.env.PFDOCS_PUBLIC_ORIGIN || process.env.VITE_PFDOCS_ORIGIN || ''};
    if (endpoint === 'documents') {
      if (req.method === 'GET') {
        const { rows } = await query(`SELECT document_id AS "documentId",pfdocs_channel_hash AS "channelHash",encrypted_metadata AS "encryptedMetadata",updated_at AS "updatedAt" FROM docs_documents WHERE owner_account_id=$1 AND document_type='prompt' AND status='active' ORDER BY created_at`,[accountId]);
        result = {ok:true,documents:rows};
      }
      if (req.method === 'POST' && bearer) {
        const body = await readJson(req,2100000);
        if (!promptUuid(body.documentId) || !/^[a-f0-9]{32}$/.test(body.channelHash || '') || !validPromptEnvelope(body.encryptedMetadata)) result = promptFailure('document_invalid');
        else result = await transaction(async client => {
          const account = await client.query("SELECT 1 FROM docs_accounts WHERE account_id=$1 AND status='active' FOR UPDATE", [accountId]);
          if (!account.rows.length) return promptFailure('setup_required',409);
          const count = await client.query("SELECT count(*)::int AS count FROM docs_documents WHERE owner_account_id=$1 AND status NOT IN ('deleted','deleting')",[accountId]);
          if (count.rows[0].count >= 100) return promptFailure('document_limit',409);
          await client.query(`INSERT INTO docs_documents(document_id,owner_account_id,pfdocs_channel_hash,encrypted_metadata,document_type) VALUES($1,$2,$3,$4::jsonb,'prompt')`,[body.documentId,accountId,body.channelHash,JSON.stringify(body.encryptedMetadata)]);
          return {ok:true,documentId:body.documentId};
        });
      }
    }
    if (url.pathname === '/api/docs/prompts/key') {
      if (req.method === 'GET') result = await getPromptKey(accountId);
      if (req.method === 'POST') result = await initializePromptKey(accountId, (await readJson(req,2_100_000)).envelope);
    }
    if (url.pathname === '/api/docs/prompts/history') {
      if (req.method === 'GET') result = await listPromptEvents(accountId, url.searchParams.get('after') || '');
      if (req.method === 'POST') result = await appendPromptEvent(accountId, await readJson(req,2_100_000));
    }
    result ||= {ok:false,status:405,error:'docs_prompt_method_not_allowed'};
    json(res,result.ok === false ? result.status || 400 : 200,result);
  } catch { json(res,500,{ok:false,error:'docs_prompt_request_failed'}); }
  return true;
}
