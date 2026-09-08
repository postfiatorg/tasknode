import { recoverLegacyRejectedReview } from "../server/task-legacy-review-recovery.js";
import { reconcileRewardPayments, retryReconciledReward } from '../server/task-reward-reconciliation.js';
import { closePool } from '../server/db/pool.js';
const args=process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/task-reward-reconcile.mjs --task TASK_ID [--apply] [--retry-failed TX_HASH | --legacy-rejection]\nDefault: read-only ledger reconciliation. --apply records validated outcomes; --retry-failed requeues an already reconciled failure with its exact transaction hash.');
} else {
  const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:'';
  try {
    if (!value('--task')) throw new Error('task_id_required');
    if (value('--retry-failed') && !args.includes('--apply')) throw new Error('retry_requires_apply');
    const result=args.includes('--legacy-rejection') ? await recoverLegacyRejectedReview({taskId:value('--task'),apply:args.includes('--apply')}) : value('--retry-failed') ? await retryReconciledReward({taskId:value('--task'),txHash:value('--retry-failed')}) : await reconcileRewardPayments({taskId:value('--task'),apply:args.includes('--apply')});
    console.log(JSON.stringify(result,null,2));
  } finally { await closePool(); }
}
