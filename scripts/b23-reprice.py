#!/usr/bin/env python3
"""Reprice Alice's remaining B23/S ask to finalized NAV. Dry run by default."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
from pathlib import Path
import socket
import subprocess

B23='ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627'
QUOTE='541e451e6ae96b6680988655571a0feec59c7f1d073c9b5d29547254cab38a3be540f8767446d25baebc7081ce97aef7'
ALICE='pfab9b9228942e5c529633a13aa271d5297bec6353'
CHAIN='postfiat-wan-devnet-2'
GENESIS='ce22ca8c932da0998b484483a09647138a30e0bf44408dd49a8d6d452787ad25521aff3ed334da07e150a7233a3e90a9'

class RpcError(RuntimeError):
    def __init__(self, error):
        self.error = error
        super().__init__(str(error))

def rpc(method, params, node=0):
    with socket.create_connection(('127.0.0.1',39650+node),10) as sock:
        sock.settimeout(90)
        sock.sendall((json.dumps(dict(version='postfiat-local-rpc-v1',id='reprice',method=method,params=params))+'\n').encode())
        response=json.loads(sock.makefile().readline())
        if response.get('ok') is not True: raise RpcError(response.get('error'))
        return response['result']

def fleet():
    with ThreadPoolExecutor(max_workers=6) as pool: rows=list(pool.map(lambda n:rpc('status',{},n),range(6)))
    assert all(r['chain_id']==CHAIN and r['genesis_hash']==GENESIS for r in rows),'wrong chain'
    assert len({(r['block_height'],r['state_root'],r['build_git_revision']) for r in rows})==1,'fleet differs'
    return rows

def latest():
    proof=rpc('nav_reserve_proof_status',{'asset_id':B23})
    return max((p for p in proof['packets'] if p['state']=='finalized'),key=lambda p:p['epoch'])

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--offer-id',required=True);ap.add_argument('--live',action='store_true')
    ap.add_argument('--key-file',type=Path);ap.add_argument('--evidence',type=Path,required=True)
    ap.add_argument('--signer',type=Path,default=Path('/home/postfiat/repos/b23-coord/artifacts/release4/postfiat-node'))
    ap.add_argument('--lock',type=Path,default=Path('/home/postfiat/repos/b23-coord/chain.lock'))
    args=ap.parse_args();args.evidence.mkdir(parents=True,exist_ok=False)
    def save(name,value): (args.evidence/(name+'.json')).write_text(json.dumps(value,indent=2)+'\n')
    save('before-six',fleet());nav=latest();offer=rpc('offer_info',{'offer_id':args.offer_id})['offer']
    assert offer['owner']==ALICE and offer['state']=='open','not Alice open offer'
    assert offer['taker_gets_asset_id']==B23 and offer['taker_pays_asset_id']==QUOTE,'wrong market'
    quantity=int(offer['taker_gets_amount_remaining']);assert quantity>0
    total=(quantity*int(nav['nav_per_unit'])+999999)//1000000
    plan={'old_offer':offer,'nav_epoch':nav['epoch'],'nav_per_unit':nav['nav_per_unit'],'quantity_atoms':quantity,'quote_atoms':total,
          'rounding':'Total quote rounded up by less than one quote atom to preserve the remaining B23 quantity.'}
    save('plan',plan);print(json.dumps(plan,indent=2))
    if not args.live:return
    assert args.key_file and args.key_file.is_file(),'key file required'
    def locked(): assert args.lock.read_text().strip()=='TRADE','chain.lock must name TRADE'
    def submit(name,operation):
        locked();quote=rpc('offer_fee_quote',{'source':ALICE,'operation_json':json.dumps(operation)})
        save(name+'-operation',operation);save(name+'-quote',quote)
        signed=json.loads(subprocess.check_output([str(args.signer),'wallet-sign-offer-transaction','--key-file',str(args.key_file),'--quote-file',str(args.evidence/(name+'-quote.json'))],text=True))
        save(name+'-signed',signed);locked()
        params={'signed_offer_transaction_json':json.dumps(signed)}
        node=0;visited=set()
        while True:
            assert node not in visited,'proposer routing loop; stop'
            visited.add(node)
            try:
                result=rpc('mempool_submit_signed_offer_transaction_finality',params,node)
                break
            except RpcError as error:
                save(name+f'-validator-{node}-error',error.error)
                match=re.search(r'retry the signed request at `validator-([0-5])`',error.error.get('message',''))
                if error.error.get('code')!='rpc_finality_wrong_proposer' or not match: raise
                node=int(match.group(1))  # exact same signed transaction, explicitly directed by the node
        save(name+'-finality',result);receipt=result.get('finality',{}).get('receipt',{})
        assert receipt.get('accepted') is True and result['finality'].get('confirmed') is True,'STOP: rejected or uncertain; inspect evidence before any new submission'
        assert receipt['tx_id']==result['tx_id'],'receipt transaction mismatch'
        save(name+'-six',fleet())
        with ThreadPoolExecutor(max_workers=6) as pool:
            receipts=list(pool.map(lambda n:rpc('receipts',{'tx_id':result['tx_id'],'limit':10},n),range(6)))
        save(name+'-receipts-six',receipts)
        assert all(len(rows)==1 and rows[0]['accepted'] is True and rows[0]['tx_id']==result['tx_id'] for rows in receipts),'receipt read-back differs'
        return result
    locked();assert latest()['reserve_packet_hash']==nav['reserve_packet_hash'],'NAV changed'
    submit('cancel',{'operation':'offer_cancel','owner':ALICE,'offer_id':args.offer_id})
    canceled=rpc('offer_info',{'offer_id':args.offer_id})['offer'];save('canceled',canceled)
    assert canceled['state']=='canceled' and int(canceled['taker_gets_amount_remaining'])==quantity,'quantity changed during cancellation; stop'
    assert latest()['reserve_packet_hash']==nav['reserve_packet_hash'],'NAV changed after cancellation; stop'
    result=submit('replace',{'operation':'offer_create','owner':ALICE,'taker_gets_asset_id':B23,'taker_gets_amount':quantity,'taker_pays_asset_id':QUOTE,'taker_pays_amount':total,'expiration_height':0})
    with ThreadPoolExecutor(max_workers=6) as pool:
        books=list(pool.map(lambda n:rpc('book_offers',{'taker_gets_asset_id':B23,'taker_pays_asset_id':QUOTE,'limit':100},n),range(6)))
    save('after-books-six',books)
    assert len({json.dumps(b,sort_keys=True) for b in books})==1,'books differ'
    found=[o for o in books[0]['offers'] if o['owner']==ALICE and o['state']=='open' and int(o['taker_gets_amount_remaining'])==quantity and int(o['taker_pays_amount_remaining'])==total]
    assert len(found)==1,'replacement not resting with exact quantity/quote; inspect before taking action'
    save('result',{'offer':found[0],'tx_id':result.get('tx_id'),'nav_per_unit':nav['nav_per_unit']})
    print('Verified replacement offer:',found[0]['offer_id'])
if __name__=='__main__':main()
