import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "modality-model-"));
process.env.TASKNODE_STORE_PATH = join(directory, "runtime.json");
process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.VERCEL_AI_GATEWAY_API_KEY = "fixture";
const { CHAT_MODALITIES } = await import("../shared/chat-personas.js");
const { apiChatModels } = await import("../server/chat-api-models.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { chatSend, chatStreamStart } = await import("../server/product-chat-contracts.js");
const { executeChat, executeChatStream } = await import("../server/chat-router.js");
const { upsertIChingProfile } = await import("../server/repositories/i-ching-profile.js");
const iChingProfile = await upsertIChingProfile({accountId:"fixture-modalities",chart:{input:{timezone:"UTC"},bazi:{},ziwei:{},combined:{input:{timezone:"UTC"},bazi:{},ziwei:{}}}});
const originalFetch = globalThis.fetch;
try {
  for (const [mode, config] of Object.entries(apiChatModels)) {
    for (const {id: persona} of CHAT_MODALITIES) {
      const payload = {accountId:"fixture-modalities", conversationId:persona+mode, mode, persona, message:"What should I consider next?", dryRun:true};
      assert.equal(chatEstimate(payload).model,config.defaultModel);
      for (const route of [chatSend,chatStreamStart]) {
        const result = await route(payload,"POST");
        assert.equal(result.status,200,JSON.stringify(result.body));
        assert.equal(result.body.estimate.model,config.defaultModel);
      }
      for (const streaming of [false,true]) {
        let calls=0;
        globalThis.fetch=async (_url,init)=>{
          const request=JSON.parse(init.body);
          assert.equal(request.model,config.defaultModel);
          calls++;
          const usage={prompt_tokens:100,completion_tokens:10,cost:0.012345};
          return streaming
            ? new Response('data: '+JSON.stringify({model:config.defaultModel,choices:[{delta:{content:"Consider the available choices."}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:"stop"}],usage})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}})
            : Response.json({model:config.defaultModel,choices:[{message:{content:"Consider the available choices."},finish_reason:"stop"}],usage});
        };
        const result=await (streaming?executeChatStream:executeChat)({...payload,conversationId:payload.conversationId+streaming,contextDocument:null,memoryContext:null,taskContext:null,jobsEssence:"",iChingProfile});
        assert.equal(calls,1);
        assert.equal(result.model,config.defaultModel);
        assert.equal(result.usage.costUsd,0.012345);
      }
    }
  }
  console.log("modality model selection passed: all estimates; eight modalities across both API preflights, streaming/nonstreaming execution and API-cost billing");
} finally {
  globalThis.fetch=originalFetch;
  await rm(directory,{recursive:true,force:true});
}
