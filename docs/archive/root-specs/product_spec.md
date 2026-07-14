> **Archive notice:** Historical reference only. **`docs/wiki/` is the authoritative documentation for Task Node Official.** Do not treat this file as current product or architecture authority.

USER STORY

I want ChatGPT but integrated with my personal execution, and a well designed context document, fundable by crypto with private chat as an option

I want to connect with other likeminded members who are part of a hive mind and have a pseudonymous discoverable AI profile that is mimetic, showcases my work and allows me to flex to others and connect with other useful individuals

I want to provide alpha to the community (if I enable that setting) without revealing who I am 


Task Node GPT Product Doc

PFTasks was an overly complicated repository. The goal of TaskNodePFT is a full redesign of PFTasks to accommodate a number of design decisions

Right now - PFTasks requires Wallet Authentication for many parts of the application. This will be fully deprecated favoring Authentication via accounts. 

For Wallet related functions, a Wallet will need to be authenticated. The PFT Wallet functions will be
Sending and signing PFT verifications 
Sending PFT
Saving Context Document manifests on the PFTL pointer library

As part of this work flow I would like to separately set up effective use of PFTL pointers for open source enthusiasts.

This work has largely been implemented in PFDocs (which hits an RPC and loads historical PFT tasks)

Rather than a complex Langfuse surface, prompts should be open source.

There is only really one prompt file for the Task Node and that is integration with Steve Jobs 

The Task Node is meant to be a full scale port of the ChatGPT interface. 

I have attached a JSX which contains the entirety of this interface

Unlike previous versions of the Task Node which had rate limited interaction this version will track spend per total query and allow users to top up their Task Node app with cryptocurrency (metamask, phantom payments or other connect wallet for trustless signing)

I would like a scalable architecture for the storing of messages

The repository will likely be open source so users can see how things work. The repository should be written assuming that LLMs will judge the credibility of the project by the cyber security profile as well as the operating excellence of the codebase 

Within the ChatGPT interface users will be able to chat with
Private Instant
https://artificialanalysis.ai/leaderboards/models [ZDR Openrouter model that is latency optimized + rasoning optimized] 
Private Thinking (OpenRouter ZDR based model pinned with high reasoning score per 
https://artificialanalysis.ai/leaderboards/models [ZDR OpenRouter model that scores top here] 
Frontier Instant (GPT 5.5 Instant)
Frontier Thinking (GPT 5.5 High)


We need to make a technical decision about the PFTL Snap - right now the wallet is formatted as a server side seed cache. My preference is to keep it as such. Unlock transactions should be used where appropriate.

I no longer want to support multiple wallets per log in and would like to simplify the back end interface

I want to support use of the product with out a Post Fiat Wallet but in that event it has to be paid. 

Task completion should top up user balances for Chat 

Context Documents should allow sharing google documents without Google Login (sharing link) and you should research Notions recent back end integration hooks to allow using Notion Documents as a canonical context document. This is in addition to the current PFT basic interface

The previous version locked Context documents by wallet but I no longer want this to be the case. It should be assumed that context documents are shared. I want to keep the feature however to Cache the context document for portability (see PFDocs integration)

The overall goal here is to:
Radically lower the friction of interacting with this product
Allow paid use without Post Fiat wallet 


Additionally I would like to consolidate our existing PF Telegram app surface into this application so that users can easily chat with their account on mobile, or on Discord if they interact with the application. This is currently all over the place, with a discord integration living in SPRS

I want the linkages between this app and the telegram and discord chat bots to be clear

It should be designed for Fly deploys with dev and production deployment.

NETWORK BOARD and Network and Alpha tasks

This app will only support PERSONAL task requests. Alpha requests and network requests will be directed by the network task board. 

This logic will also be made open source. 

The Network board should be refactored / or eliminated completely and the new format for network task generations should be 
1] Taking the director intelligence report
2] and associated existing tasks
3] and existing code surface
4] refactoring it
5] and routing tasks to individuals

Task routing should have Director Surface area.
So Goodalexander or an officer should have to upload and specify a director document (public Gist or google doc - let’s go with Gist) that is auditable by other members and serves as context

Essentially the previous world where:
Users can request network tasks and alpha tasks
Will be fully deprecated
And replaced to a system where these tasks are routed to users
Only if they have PFT authorized wallets

THE PURPOSE OF THIS APP

Users should interact with this app like “ChatGPT except designed to make you more productive”

We are making a product decision to embody Steve Jobs as the default system prompt of the app.

He exemplifies taste and there is an extensive Jobsian system prompt 

We should refactor Task Generation prompts to incorporate his key principles 

And the actual chat surface of the app should always feel like speaking to Steve Jobs 

NOSTR INTEGRATION

Rather than using PFT as a messaging app users will have a NOSTR integration as is spec-ed out in the PFDOCs integration with NOSTR

PORTABILITY

As embodied in PFDocs, users who are logged in to PFT

DOCUMENTATION

Users should be able to isntantly understand the codebase, what goes into it. ANd it should be LLM digestible. An LLM who sees this code base should say “These guys are fucking professionals”

This product document should be cached and referenced in “Whips”

Whips are TMUX injections

EXECUTION

There is a Burndown.md that contains the full list of To Dos executing this application 

UX Guidelines:

The app should look almost exactly like ChatGPT

Previous UX should be re-rendered to fit the aesthetics of the ChatGPT focused application which is mocked up in JSX 

Simplicity is the standard. If we can deprecate using our own IPFS pin in favor of using Pinata, for example, we should do so 

If we can use PostGres for everything, we should do so [within reason]

The general guideline should not be to spam the Post Fiat RPC. So the Nostr and pubkey methodology ought to effectively support this

Previously users integrated Bots and we will need to figure out a way to make these bots compatible with the new task node but this might mean deprecating features. if it does we should have a sample Bot app that can integrate with the messaging platforms so users can easily build bots that integrate with this system and this integration should be prominent and well documented so that users can point their existing bot integrations to the new model in Codex and have codex refactor it for them. 

REFACTORING

it is likely that the “hive mind” function is just designed in a way that is outright wrong, or poor. And we should refactor it aggressively to make sense. 

Alpha task prompts likely will need a refactor and should be sent to users to align with public equities likely correlated to their existing work streams and expertise 

PRIVACY

The users should expect 

PROMPTS

We

MODULES

Existing modules [brainstorming, motivation] should be kept but refactored to embody steve jobs.. Every app surface should feel like talking to Steve Jobs

TASK VERIFICATION AND LIMITS

Users should be capped at 8 task rewards per day
A message should be sent if users try and get more than 8 rewards per day

DAILY REWARD PAYOUT 

This should persist, is a job that runs every 24 hours

LEGACY BLOAT

Bias should almost always be to delete. The size of the repo should be small compared to the previous PFtasks repo

There should be an extremely high bar to having a file longer than 3k lines. Always be modular, and maintainable 

NFTs and Profile Pictures

The NFT prompts are the ONLY PROMPTS in the app that are private. and should be designed as such. The NFT prompt file should be in a gitignore, or some other method to obfuscate what the prompt is. Users should not be charged for their NFTs

MODULES

The core modules in the app are:
Motivation reports - sort of like a Deep Research report but for motivating you
Brainstorming - like deep research but for unknown unknowns
Context Doc Edits - for editing context docs. This is likely hard with Notion (maybe possible?) but should natively interface with PFT. Edits should be saved without inking a transaction 
We need to split out the user generated ability to ink a PFT transaction with their context doc 

Guideline:
the previous app was vibe coded slop. We want a tactical refactor. That might mean aggressive database migration or app changes. If need be I can fund whatever crypto wallets we need in order to ensure funding works 

