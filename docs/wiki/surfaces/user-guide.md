# User Guide

This is the plain-English guide to Task Node. It explains every surface a normal user can touch, what each thing is for, and how to describe the app to someone who has no idea what is going on.

Task Node is an AI-assisted work app for Post Fiat. You bring your context, wallet, and judgment. The app helps you turn that into useful tasks, network coordination, rewards, profile reputation, and proof of contribution.

The shortest explanation:

Task Node is a chat-first, AI-assisted work system where people keep a live context document, request or receive tasks, submit evidence, earn PFT, and help coordinate shared Post Fiat network work.

The AI parts help generate tasks, explain app state, summarize context, route network work, draft evidence, score some outputs, and make recommendations. The user still controls account actions through the app surfaces. Do not assume that a human reviewed, verified, assigned, or approved something unless the app explicitly says that.

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

Use Search when you are trying to recover a prior conversation, task, context entry, or related work artifact.

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
