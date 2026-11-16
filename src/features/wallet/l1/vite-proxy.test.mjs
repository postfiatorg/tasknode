import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as viteServer } from 'vite';
const api=httpServer();const wss=new WebSocketServer({server:api});api.listen(0,'127.0.0.1');await once(api,'listening');
process.env.TASKNODE_API_ORIGIN=`http://127.0.0.1:${api.address().port}`;
const reserve=httpServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const vite=await viteServer({server:{host:'127.0.0.1',port,strictPort:true},logLevel:'error'});let socket;
try {
 assert.equal(vite.config.server.proxy['/api'].ws,true);await vite.listen();const origin=`http://127.0.0.1:${port}`;
 wss.on('connection',(ws,req)=>{assert.equal(req.url,'/api/l1/rpc');assert.equal(req.headers.origin,origin);ws.on('message',data=>ws.send(data));});
 socket=new WebSocket(`ws://127.0.0.1:${port}/api/l1/rpc`,{origin});await once(socket,'open');const response=once(socket,'message');socket.send('synthetic-read-only-proxy-check');assert.equal(String((await response)[0]),'synthetic-read-only-proxy-check');
 console.log('PASS: repository Vite /api config forwards WebSocket upgrade and frames, retaining browser Origin. Local echo only.');
}finally{socket?.terminate();for(const client of wss.clients)client.terminate();await vite.close();wss.close();await new Promise(r=>api.close(r));}
