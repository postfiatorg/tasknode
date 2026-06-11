# User Guide

This is the plain-English guide to Task Node. It explains every surface a normal user can touch, what each thing is for, and how to describe the app to someone who has no idea what is going on.

Task Node is an AI-assisted work app for Post Fiat. You bring your context, wallet, and judgment. The app helps you turn that into useful tasks, network coordination, rewards, profile reputation, and proof of contribution.

The shortest explanation:

Task Node is a chat-first, AI-assisted work system where people keep a live context document, request or receive tasks, submit evidence, earn PFT, and help coordinate shared Post Fiat network work.

The AI parts help generate tasks, explain app state, summarize context, route network work, draft evidence, score some outputs, and make recommendations. The user still controls account actions through the app surfaces. Do not assume that a human reviewed, verified, assigned, or approved something unless the app explicitly says that.

## Screen-by-Screen Feature Map

Use this section when a user asks what Task Node is, where something lives, what a page means, or what to do next.

### Chat Screen

Chat is the main AI workspace. It can answer questions, reason through work, draft task evidence, explain app state, summarize prior work, and help the user decide what to do. It reads the signed-in user's Context, Memory, task state, and recent conversation when those are available.

Chat does not secretly press product buttons. It cannot accept a task, refuse a task, submit evidence, mint an NFT, send PFT, edit Context, or create Hive work unless the user uses an explicit app control.

The chat mode picker changes the provider and behavior:

- `Private Instant` is fast private OpenRouter chat for normal reasoning.
- `Private Thinking` is slower private OpenRouter reasoning for harder questions.
- `Discount Thinking` is direct DeepSeek reasoning for lower-cost deeper analysis.
- `Frontier Instant` is OpenAI frontier chat with prompt-governed web search and file understanding.
- `Frontier Thinking` is OpenAI frontier reasoning for deeper or more source-heavy work.
- `Help` is product help. It uses this guide plus the user's available app context to explain what the user is seeing and which surface to use.

The `More` or thinking disclosure on assistant messages can show the source context passed into the model, including retrieved Steve Jobs corpus chunks when available. That Jobs vector database is not a user-facing task system; it is source material used to calibrate product judgment and response style.

### Chat `+` Menu

The `+` menu is where chat becomes an explicit product action.

`Request task` turns the next message into a signed personal task request. It requires a signed-in account, linked wallet, and unlocked wallet vault because the request is published as a wallet-bound task request. The generated task appears later as a proposed task card in Tasks.

`Context Refine` turns the next message into a structured edit request for the user's Context document. It does not require an unlocked wallet because it edits the account-scoped current Context draft. The model returns a proposal card in chat. The user must click `Accept & save`, reject it, or ask for another refine pass.

### Tasks Screen

Tasks is where work cards become real user actions. It shows proposed, accepted, verification, refused, and rewarded task records. Open a task to read the title, objective, steps, requested output, reward, state, and verification requirement.

For a proposed task, the user accepts it if they will do the work or refuses it if it is wrong. For an accepted task, the user submits evidence. For a verification request, the user answers the specific follow-up. Task actions are wallet-bound signing actions and may ask the user to unlock the local wallet vault.

Personal tasks come from the user's own request. Network Tasks come from Hive routing for shared network projects.

### Context Screen

Context is the durable working document that tells Task Node who the user is, what they are building, what matters, and what constraints the assistant should remember. Chat, task generation, Context Refine, and some profile/recommendation flows depend on it.

The editor autosaves the current draft into the account database. That current draft is the normal source used by chat and task generation. The `Saving`, `Saved`, or dirty state describes this current account cache, not necessarily an on-chain publication.

`Publish to PFT` is separate. Publishing encrypts the Context, pins it through IPFS, and writes a PFTL pointer so there is a wallet-scoped history record. Publishing requires a linked and unlocked wallet. Historical Context entries may need wallet unlock to decrypt previews. Cached historical previews are for the browser session and are not the same as the current editable draft.

Line numbers shown in Context and Context Refine are anchors into the normalized plain-text version of the document. They help the edit model and the user refer to the same section; they are not a separate document format.

### Memory Screen

Memory is a compressed record of useful chat history. It helps future chats carry continuity without replaying every conversation. Memory is lower authority than the user's current message and Context. If chat seems stale, update Context first and inspect Memory second.

### Wallet Screen

Wallet is the PFT identity, signing, custody, transaction, top-up, and local vault surface. It shows the linked PFT address, PFT balance, transaction feed, local seed vault state, top-up credit, initiation gift status, send controls, and seed backup controls.

Account login and wallet custody are separate. A connected provider such as email, GitHub, X, Telegram, or Discord proves account identity. A linked PFT wallet signs wallet-bound actions and receives PFT. The seed phrase, private key, wallet password, and decrypted vault are not sent to the server.

`Locked` means the app knows the wallet address but the browser has not decrypted the local vault for signing. `Unlocked` means the browser can sign wallet-bound actions for the current session. Unlock survives normal reloads for the session through encrypted browser storage, locks after inactivity, and clears on lock, logout, local-vault removal, or tab close.

Top-up credit is separate from PFT. Top-up uses an account-scoped Ethereum deposit address for app usage credit, such as model calls. That deposit address is not the PFT wallet and is not where task rewards are paid.

### Profile Screen

Profile has `Private` and `Public` tabs plus a profile visibility toggle.

The private tab is the user's control room. It shows daily airdrop state, identity controls, Profile Studio, PFT generation history, the private NFT gallery, and recommended connections.

The public tab previews what other discoverable users can see: Hive handle, selected public aliases, display wallet, role summary, skills, contribution level, alignment score, lifetime PFT, and public profile NFT gallery. If the profile is hidden, the user should not appear in recommended connection discovery.

### Daily Airdrop On Profile

Daily Airdrop is an account-level PFT distribution based on recent rewarded work and account state. It is not the same as a task reward. Task rewards come from completing individual tasks; the daily airdrop is an additional daily scoring and payout path.

The panel shows the latest or today's airdrop amount, payout status, transaction hash when paid, what raised the score, what kept it lower, and what to improve tomorrow. `Full reasoning` shows the longer scoring explanation when available.

Alignment score is the latest seven-day airdrop alignment score shown on a 0 to 100 scale. In plain English, it compares the account's actual recent airdrop outcome against the maximum possible airdrop signal for that scored window. The public profile explains it as actual airdrop PFT out of possible airdrop PFT over the scored window. It is not a moral score and it is not a human judgment; it is a recent contribution-alignment metric from the daily airdrop scoring run.

### Profile NFT And Minting

Profile Studio generates profile art from the user's recent Task Node profile state. Generation creates a durable draft row first, then calls image generation, pins the image to IPFS, and makes the draft mintable. If the user leaves during generation, the draft remains recoverable and Profile polls until it finishes or fails.

`Regenerate` creates or retries a generated draft. `Mint as NFT` turns a generated draft with an image CID into a wallet-owned PFTL NFT. Minting requires the linked local wallet vault to be unlocked because the browser signs the mint transaction. Mint status moves through preparing, signing, broadcasting, confirming, and minted.

Generated, prepared, and minted NFTs can appear in the private gallery. Public profile shows public-safe active-wallet NFTs, not failed private drafts.

### Recommended Connections

Recommended Connections appears on the private Profile tab. It suggests public/discoverable members who may be useful to know or work with next. Each recommendation shows the member, a reason, supporting signals, and a suggested first move.

Click `View profile` or the member name to open the sanitized member preview. The preview can show their public role summary, skills, lifetime PFT, rewarded task count, public handle, and display wallet. Wallet links can open the explorer or be copied. These interactions do not message that person and do not create a task; they only help the user inspect or contact the right identity outside the recommendation card.

Recommendations require enough public/discoverable member data to compare against. If the user's profile is private, recommendations are off and the user should not be included in other users' recommendation runs.

### Hive Screen

Hive is the group coordination board. It shows shared Post Fiat projects, Network Task routing, contributor activity, Hive Context, and Hive Mind Agent activity. It is where the user inspects network work, not where they accept or submit tasks.

Hive Chat is a pinned chat conversation for contributing network context. A Hive Chat message is saved to Hive Context. The immediate response can explain board state, but it does not create a task by itself. Network Tasks are routed later by the Board Manager when there is a project need, eligible contributor capacity, and a matching user profile.

Hive Context validation means the entry came from an account with a linked PFT wallet. Ordinary Hive Chat messages do not require the wallet vault to be unlocked. Wallet unlock is needed later for signed task actions.

### Telegram Login And Telegram Chat

Telegram can be used as a connected login/provider identity when enabled. Linking Telegram attaches that Telegram identity to the same Task Node account cloud.

Telegram bot chat is a phone-sized delivery surface for Task Node chat. It should be concise, account-aware when linked, and clear about what is missing. Telegram chat does not bypass the app's normal wallet, task, reward, or Context action boundaries.

### Billing And Usage Credit

Billing shows app usage credit and model-run ledger entries. Chat and model features spend usage credit based on provider usage. PFT task rewards and PFT wallet balance are separate from usage credit.

### Help And Docs

Help mode in Chat answers product questions using this guide and available runtime context. The Help/Docs screen exposes user-facing documentation and prompt/source maps. Use Help when the user does not know which page to use or why they are seeing a state.

### Search And Agents

Search is for finding cached prior app records such as conversations, tasks, context entries, or work artifacts. Agents is an advanced external-worker surface for wallet-native workers; most normal users can ignore it until they are operating a separate agent.

## First Session Checklist

1. Use `Log in or sign up` in the profile/account area to create or enter an account.
2. Choose a Hive handle on Profile or Settings.
3. Link or create a PFT wallet on Wallet.
4. Save your seed phrase if you create a wallet. Task Node cannot recover it for you.
5. Write or update your Context so the app knows what you are working on.
6. Use Chat to reason through work, or select Help mode when you need plain-English app guidance.
7. Use the `+` button to request a personal task or propose a context edit.
8. Use Tasks to accept, refuse, submit evidence, and track rewards.
9. Use Hive to understand group projects and Network Tasks.
10. Use Profile to check public identity, task history, daily airdrop state, recommended connections, and profile NFTs.

## Identity And Connected Accounts

### What It Is

Identity is the account layer. It includes sign-in, connected providers, Hive handle, public aliases, and wallet proof.

Your Task Node account can have email, GitHub, Telegram, X, wallet, and future providers attached to the same account cloud. These are private identity and recovery signals unless you explicitly make an alias public.

The Hive handle is the public name other people see in the network.

### How To Use It

Sign in with an available provider. Choose a Hive handle. Link any provider accounts you want attached to the same Task Node identity. Decide which aliases, if any, should be public.

If you are signed out, start from the `Log in or sign up` control in the profile/account area. You can continue with an enabled provider such as email, GitHub, X, Telegram, or another configured provider. Email sign-in asks for an email address and then a code. After sign-in, the app can save chat history, Context, Memory, Tasks, Wallet state, Profile, and Hive-related state to your account.

Do not confuse provider identity with wallet custody. A connected account can prove who you are. A linked PFT wallet signs wallet-bound actions.

### How To Explain It

Identity is how the app knows the account is yours. The Hive handle is how the network sees you. The wallet is how you sign and receive PFT.

## Chat

### What It Is

Chat is the main work surface. It uses your current context, memory, task state, and selected model mode to help you think, write, plan, debug, or decide.

Chat is not an invisible operator with permission to change the app. It can reason, draft, summarize, and explain. It changes app state only when you use explicit product controls, such as the `+` button for task requests or context edits.

### How To Use It

Use Chat when you want to think through a problem, ask what is going on, summarize recent work, draft evidence, prepare a task response, or clarify what you should do next.

Select Help mode when you want the app explained in plain English. Help mode uses your current context, task state, memory, and this guide so it can tell you which surface to use next.

Use the `+` button when you want a product action:

- request a personal task;
- ask for a context edit;
- use any other explicit action exposed by the app.

Ask short questions when you want a short answer. Ask for a longer analysis when you want the model to go deep.

### How To Explain It

Chat is the AI thinking surface. It knows your context and tasks, but it does not secretly press buttons for you. It helps you decide what to do and draft the work.

## Context

### What It Is

Context is the durable document that tells Task Node who you are, what you are building, what matters, and what constraints the assistant should remember.

This is one of the most important surfaces in the app. Bad context produces bad tasks, bad advice, and bad routing. Good context makes the app feel personalized and useful.

### How To Use It

Open Context and keep the document accurate. Write in normal language. Include current priorities, active projects, constraints, preferences, and anything the assistant should not forget.

Update it when your work changes. Remove stale priorities. If the assistant is behaving from old assumptions, check the context document first.

You can edit it directly, or use Refine Context to clean it up without changing the meaning.

### How To Explain It

Context is your working profile. It is the source material the app uses to understand what matters to you.

## Refine Context

### What It Is

Refine Context is a focused editing tool for your context document. It helps clean, organize, and clarify your context without changing the underlying meaning.

### How To Use It

Use it when your context has become messy, too long, stale, repetitive, or hard to scan. Review the proposed edit before applying it. Do not apply a change that removes important nuance.

### How To Explain It

Refine Context is the editor for the document that guides the rest of the app.

## Wallet

### What It Is

Wallet is your PFT identity and value surface. It shows your linked PFT wallet, balance, transaction activity, local vault state, rewards, and top-up state.

Task Node separates account login from wallet custody.

Your app account proves who you are inside Task Node. Your wallet proves PFT ownership and signs wallet-bound actions. Your local seed vault is encrypted in your browser. The server does not receive your seed phrase, wallet password, private key, or decrypted vault.

### How To Use It

Use Wallet to:

- create or link a PFT wallet;
- unlock or lock the local vault;
- back up the seed phrase;
- send PFT;
- view PFT balance and recent transactions;
- inspect top-up status;
- understand whether the wallet is ready for task signing.

You can view balance and activity while locked. You must unlock the wallet before signing actions such as requesting tasks, accepting tasks, refusing tasks, submitting evidence, publishing context, minting profile NFTs, or sending PFT.

### Wallet Help Chat First-Run Copy

Designed to answer:

1. What is the Wallet for?
2. Do I need a wallet before I can use Task Node?
3. Why does the wallet lock and unlock?
4. What is the difference between PFT, rewards, and top-up credit?
5. What task states should I understand?
6. How do I submit work?
7. What happens after I submit evidence?
8. Where should I look when I am confused?

Help chat script:

The Wallet is where your PFT address, balance, local vault, top-up status, and signing state live. Your app account proves who you are inside Task Node. Your wallet proves PFT ownership, signs task actions, and receives PFT rewards.

You do not need an unlocked wallet for ordinary chat or reading the app. You do need a linked wallet for task signing and PFT rewards. If you create a wallet, save the seed phrase. Task Node cannot recover it for you.

Locked means the app knows your linked wallet, but your browser has not decrypted the local vault for signing. Unlocked means your browser can sign wallet-bound actions for this session. The server does not receive your seed phrase, private key, wallet password, or decrypted vault.

PFT is the token used for task rewards and wallet actions. Top-up credit is different. Top-up credit pays for app usage, such as model calls. A top-up deposit address is not your PFT wallet.

Task states are simple:

Proposed means a task is offered, but you have not accepted it.
Accepted means the task is on your plate.
Submitted means you sent evidence for review.
Verification requested means the app needs a specific follow-up answer or proof.
Verification response submitted means your follow-up was sent and the task is waiting.
Rewarded means the task lifecycle completed with a reward.
Refused or cancelled means the task is closed without becoming your active work.

To submit work, open Tasks, choose the accepted task, and use Submit evidence. Good evidence is specific: changed files, commands run, test results, screenshots, links, transaction hashes, CIDs, or a short proof note. If the app asks you to unlock the wallet, that is because task evidence is a signed wallet action.

After submission, the task moves through the verification and reward workflow. The app may ask for one follow-up if the evidence is incomplete. If the task is rewarded, the reward appears in your task history and PFT accounting.

#### If you're not sure what to do next

Open Tasks first. If you have a proposed task, accept it or refuse it. If you have an accepted task, complete it and submit evidence. If you have a verification request, answer that specific request. If you have no task, use Request task or the Chat `+` button to ask for a personal task.

Open Wallet when an action is blocked by a missing wallet, locked vault, missing seed backup, balance issue, send issue, or top-up issue. Open Help when you need the app explained in plain English. Open Hive when the question is about Network Tasks or group work.

### How To Explain It

Wallet is your Post Fiat identity and signing tool. Task Node can show wallet state, but the private key stays with the user.

## Topping Up

### What It Is

Top-up is the account credit rail for app usage. It is different from the PFT wallet.

The app can derive an Ethereum deposit address for your account. Deposits such as USDC are detected and credited to app usage. That deposit address is account-scoped billing infrastructure. It is not your PFT wallet, and it is not a place where the app stores your PFT seed.

### How To Use It

Open Wallet and find the top-up or billing section. Copy the deposit address shown by the app. Send the supported token on the supported network. Wait for the app to detect the deposit and update credit.

Do not assume every token, network, or wallet action is supported. Use the exact instructions shown in the app.

### How To Explain It

Top-up is how the user adds app credit. The PFT wallet is how the user signs Post Fiat actions and receives PFT rewards. They are related in the app, but they are not the same thing.

## Tasks

### What It Is

Tasks are work objects. A task has a title, objective, steps, reward, state, and verification requirement.

Tasks are backed by PFTL and IPFS. The app shows a fast task list, but the important lifecycle events are signed and replayable.

There are two main task kinds users need to understand:

- Personal Tasks are requested by the user.
- Network Tasks are routed by Hive for shared group projects.

### How To Use It

Open Tasks to see outstanding, verification, refused, and rewarded work.

For a proposed task, accept it if you will do the work. Refuse it if it is wrong, unclear, not useful, or not something you should do.

For an accepted task, complete the work and submit evidence. Evidence should be specific enough for review. Good evidence includes changed files, commands, screenshots, links, transaction hashes, CIDs, or a concise proof artifact when relevant.

If the app asks for verification, answer the verification request. If the task is rewarded, the lifecycle is complete. Rewarded means the task state changed through the app's verification and reward workflow; it does not automatically mean a human reviewed it.

### How To Request A Personal Task

Use the `Request task` button or the Chat `+` menu. Describe the work you want in plain English. The app uses your context, memory, chat, wallet, and current task queue to generate a proposed personal task.

A requested task may take time to appear because the request is signed, published, generated, indexed, and projected into the Tasks UI. You should not need to reload the page once the projection catches up.

### How To Explain It

A task is a paid, verifiable work card. Personal tasks come from the user. Network Tasks come from the group coordination system.

## Hive

### What It Is

Hive is the group coordination surface. It shows what the Post Fiat network is working on, which projects are active, what tasks are moving, who is contributing, and what the Board Manager is doing.

Hive is not just chat. It is the group layer of Task Node.

### How To Use It

Use Hive to understand active network projects, project needs, recent activity, and Network Task routing.

Use Hive Chat when you want to tell the coordination layer something relevant, ask why routing is happening, or add context that the group should consider.

Hive Chat cannot create personal tasks for you. It can record context and explain state. Project-linked Network Tasks are routed by the Board Manager when there is a project need and an eligible contributor.

Board Manager is an AI-assisted coordination system. It can route, summarize, and recommend network actions through the product workflow. It is not a human manager, and Help should not describe it as one.

### Hive Chat First-Run Path

For a first Hive Chat session:

1. Sign in or create an account.
2. Choose a Hive handle on Profile.
3. Link or create a PFT wallet on Wallet.
4. Open the pinned `Hive Chat` conversation in Chat.
5. Send a short message describing what you can contribute or what network context the Board Manager should know.
6. Open Hive to inspect active projects and Board Manager activity.
7. Open Tasks when a Network Task is proposed, because acceptance, refusal, evidence submission, verification, and reward state happen there.

Hive Context validation means the Hive entry came from an account with a linked PFT wallet. Ordinary Hive Chat messages do not require the wallet vault to be unlocked. Wallet unlock is needed later for signing wallet-bound actions such as accepting a task or submitting evidence.

### How To Explain Network Tasks

Network Tasks are paid work for the group. They are meant to advance shared Post Fiat projects, not just personal productivity.

The system tries to route Network Tasks when:

- the user has a signed-in account;
- the user has a linked PFT wallet;
- the wallet is indexed and active;
- the user has enough task/reward history for a Network Diagnostic Report;
- the user is not already consuming Network Task capacity;
- Hive has a real project need that matches the user.

### How To Explain It

Hive is the network board. It helps a group of people who do not all know each other coordinate useful work across shared projects.

## Profile

### What It Is

Profile is the member trust surface. It shows how the account appears to the network: Hive handle, public/private state, aliases, earned PFT, contribution level, profile NFTs, recommended connections, and daily airdrop state.

The profile belongs to the account identity cloud, not only to one wallet. The NFT library is scoped to the currently linked wallet.

### How To Use It

Use Profile to:

- choose or edit your Hive handle;
- decide whether your profile is public or private;
- manage public provider aliases;
- view lifetime task rewards and daily airdrop rewards;
- generate or refresh the public profile snapshot;
- view recommended connections;
- view or mint profile NFTs.

Profile visibility defaults to public. If you set it private, you should not be discoverable through recommended connections.

### How To Explain It

Profile is your Task Node reputation page. It turns real task history, wallet-linked activity, and public identity choices into a member surface other people can understand.

## Daily Airdrop

### What It Is

Daily Airdrop is a recurring PFT distribution based on recent rewarded work and account state.

It is not the same as a task reward. Task rewards come from completing a task. The daily airdrop is an additional account-level distribution calculated from recent contribution signals.

### How To Use It

Open Profile or Daily Airdrop to inspect your current score, what helped it, what kept it lower, and what to do tomorrow.

If the page says no rewarded tasks were found in the lookback window, the practical fix is to complete and receive a positive reward for a verifiable task.

### How To Explain It

Daily Airdrop is a daily PFT drip for accounts that are actively producing rewarded work.

## Profile NFTs

### What They Are

Profile NFTs are profile artifacts minted from the user's Task Node profile state. They can become avatar or profile images and are tied to wallet NFT ownership.

Generated drafts and minted NFTs are different. A generated draft is an app record. A minted NFT is a wallet-owned on-chain NFT with metadata and image CIDs.

### How To Use Them

Open Profile to generate, view, paginate, and mint profile NFTs. Minting requires the linked local wallet vault to be unlocked because the browser signs the NFT mint transaction.

If generation is still running, Profile shows a saved in-progress draft. It is
safe to leave the page or refresh; return to Profile and the draft will still be
visible. Completed drafts appear in Profile Studio and the NFT gallery. Failed
drafts stay visible privately with a retry path.

The app renders NFT images through the profile image proxy so old or migrated IPFS assets can be fetched reliably without the browser trying many gateways directly.

If an NFT image cannot be fetched, the app should show an explicit unavailable-image state instead of silently substituting fake art.

### How To Explain Them

Profile NFTs are wallet-owned profile artifacts. They are a visible way to carry identity and contribution history through the Post Fiat network.

## Recommended Connections

### What It Is

Recommended Connections helps users discover other public members who may be useful to know.

The recommendation should show the person, why they are relevant, and a suggested first move. It should not be a mysterious score.

### How To Use It

Open Profile and review the recommended people. Use the reasons and suggested first move to decide whether to contact, review, follow, or collaborate with someone.

If your profile is private, you should not be included in other users' recommendation calculations.

### How To Explain It

Recommended Connections is the app's way of saying, "Here are a few people in the network who may matter to your work, and here is why."

## Memory

### What It Is

Memory is the app's compressed record of useful chat history. It helps future chats carry continuity without rereading every conversation.

### How To Use It

Use Memory to inspect what the app thinks it remembers. If chat is acting from stale assumptions, check Memory and Context. Context is the higher-priority source for durable work state.

### How To Explain It

Memory is continuity. Context is the canonical current profile. Memory helps the assistant remember prior conversations.

## Search

### What It Is

Search helps find cached work across app records.

### How To Use It

Use Search when you are trying to recover a prior conversation, task, context entry, or related work artifact. The sidebar `Search chats` button searches your own chats by title and message content and opens the matching conversation.

### How To Explain It

Search is the retrieval surface for work that already happened in the app.

## Agents

### What It Is

Agents are external wallet-native workers. They are not the normal first user path.

### How To Use It

Use Agents only when you are operating or connecting an external worker that should interact with Task Node through wallet-native flows.

### How To Explain It

Agents are for advanced external workers. Most users start with Chat, Context, Wallet, Tasks, Hive, and Profile.

## A Simple Explanation For A New User

Task Node is a Post Fiat work app.

You sign in, set your context, link a PFT wallet, and use chat to think through work. You can request personal tasks for yourself. Hive can route Network Tasks when the group has shared work that fits you. You submit evidence, move through verification, and earn PFT when the task is rewarded. Your profile turns that history into reputation, recommendations, airdrop eligibility, and profile NFTs.

The important thing to understand is that Task Node is not just a chatbot. It is a task, wallet, profile, and group coordination system built around verifiable work.
