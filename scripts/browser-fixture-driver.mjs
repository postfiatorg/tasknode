import WebSocket from 'ws';
function connect(url) {
  const socket=new WebSocket(url), pending=new Map();let id=0;
  const ready=new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.on('message',raw=>{const message=JSON.parse(String(raw));const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}});
  return {socket,ready,command:async(method,params={})=>{await ready;return new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));});}};
}
export async function browserFixture({port=9347}={}) {
  const origin=`http://127.0.0.1:${port}`;
  const info=await fetch(origin+'/json/version').then(response=>response.json());
  const browser=connect(info.webSocketDebuggerUrl);
  const {browserContextId}=await browser.command('Target.createBrowserContext');
  const pages=[];
  return {
    async page({url,intercept}) {
      const {targetId}=await browser.command('Target.createTarget',{browserContextId,url:'about:blank'});
      const targets=await fetch(origin+'/json/list').then(response=>response.json());
      const connection=connect(targets.find(target=>target.id===targetId).webSocketDebuggerUrl);pages.push(connection);
      const {command,socket}=connection;
      if(intercept){socket.on('message',async raw=>{const event=JSON.parse(String(raw));if(event.method!=='Fetch.requestPaused')return;const {requestId,request}=event.params;
        try {
        const response=await intercept(request);
        if(response?.fail)return await command('Fetch.failRequest',{requestId,errorReason:'ConnectionClosed'});
        if(response)return await command('Fetch.fulfillRequest',{requestId,responseCode:response.code||200,responseHeaders:[{name:'content-type',value:response.type||'application/json'}],body:response.base64Body||Buffer.from(typeof response.body==='string'?response.body:JSON.stringify(response.body)).toString('base64')});
        await command('Fetch.continueRequest',{requestId});
        } catch (error) { if (error.message !== 'Invalid InterceptionId.') throw error; } // Navigation can cancel an intercepted request before its fixture resolves.
      });await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});}
      await command('Page.enable');await command('Runtime.enable');
      await command('Page.navigate',{url});
      const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
      return {command,evaluate,async until(expression){for(let attempt=0;attempt<150;attempt++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Browser condition failed: '+expression);}};
    },
    async close(){for(const page of pages)page.socket.close();await browser.command('Target.disposeBrowserContext',{browserContextId});browser.socket.close();},
  };
}
