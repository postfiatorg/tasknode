# Daily alignment production investigation — 2026-09-10

Scope: explain the Profile daily-airdrop Alignment value, active model, and confusing explanations. Production inspection was read-only; no scoring rules, stored scores, or payouts changed.

## Production evidence

Queried `profile_daily_airdrop_runs` and `profile_daily_airdrop_issuances` on Fly app `tasknodeofficial-dev`, with bounded reads. Checked allowlisted model/cap environment settings on the active airdrop worker `1850d37c3d3e48`; all overrides checked were unset, so defaults apply.

- All 14 completed production runs dated September 10 used Vercel `zai/glm-5.3`, prompt version `daily_airdrop_v1`, digest `4b2df4fd216d8dcb769de92f9a87b64a7519784b3f65a671d44de636876d250d`. All 14 issuances had status `submitted`.
- September 6–10 completed production rows used this model/provider. September 3–4 rows used Ambient `z-ai/glm-5.2`; September 5 had 11 Ambient and two Vercel runs.
- September 10 retention scores ranged from 48 to 94. Rounded UI alignment values ranged from 0 to 10; six of 14 rounded to zero.
- The production packet policy used `max_daily_pft=10000`, `max_reward_fraction=null`.

## Calculation and inputs

`server/profile-daily-airdrop.js::buildDailyAirdropTaskRewardPacket` collects at most 80 positive rewarded tasks in a rolling seven-day window across the account's synchronized user wallets, including historical wallets. Each task contains its title, kind, offered/paid amount, prior reward-review summary, completion/evidence-quality scores, timestamp, and reference identifiers. It does not provide the full original task contract, raw submitted artifacts, or the user's broader context document and chat history.

`prompts/profile/daily_airdrop_v1.md` asks how much a crypto network would rationally pay today to retain the contributor. It gives qualitative preferences for shipped artifacts and visible network value but no numeric calibration rubric. The model independently returns a PFT amount, a 0–100 retention score, and explanations. Runtime uses temperature zero, high reasoning effort, and a strict JSON response format. The normalizer caps the amount at 10,000 PFT by default, and forces zero for no positive rewarded work or model-declared ineligibility.

The Profile UI does **not** display `retention_value_score`. It displays:

`round(100 * sum(completed production scoring amounts) / sum(those runs' max_daily_pft))`

The sums come from stored `alignment_score_7d`, not a fresh UI calculation. Only completed production rows between the packet lookback start date and run date are queried. This is a ratio of proposed airdrops to configured maximums, not an independent assessment of alignment with user goals.

## Confirmed defects and explanation weaknesses

1. **Misleading label and scale.** Good retention scores can render as zero alignment because small PFT awards are divided by a 10,000-PFT daily ceiling and rounded to an integer.
2. **Current production run omitted.** `runDailyAirdropScore` queries the completed-run window before completing the current run. Only dry-run mode explicitly adds the current amount and maximum. Thus today's displayed amount and explanation accompany a percentage based on earlier scoring rows. A first production run necessarily gets a zero denominator and zero alignment.
3. **Scoring amounts are called actual airdrops.** The aggregation does not join issuance records or require a submitted payout. All 14 September 10 payouts were submitted, so this is a calculation-contract defect, not evidence of failed payment on those rows.
4. **Task-specific evidence requirements are not preserved structurally.** The generic prompt can penalize local evidence even when the original task explicitly accepted it. It receives prior review summaries, but not the full task contract or a structured allowed-evidence policy.
5. **Routing metadata can influence valuation.** A sampled explanation used all-time recipient task/reward counts to justify retention value, while another explicitly excluded all-time history as outside lookback evidence. The packet exposes these counts for wallet selection without a clear exclusion from valuation.

## Concrete source rows

Identity resolution from the preceding incident established `0xpostfiatchad` as account `acct_oauth_b259edff110c43d66cb95267`, with wallet `rpHvzMCKZ7JrzGfRseXohC3RsMWqcnEKkA`. Its September 10 run `airdrop_a3f4ef6b-8ed0-4ae2-8a0d-61044d0386f2` contains:

- Eight rewarded tasks, 24.35 PFT in the lookback; daily airdrop 45 PFT; retention score 80.
- Stored prior airdrop total 305 PFT and maximum 70,000 PFT: `305 / 70000 * 100 = 0.435714…`, rounded to **0/100** by the UI.
- Daily explanation discounts self-attested local evidence and recommends public commits/PRs/CI. In the same input packet, reward summaries for `task_c26d27a9e112a7ad1c27682b95f0790e` and `task_bdb4280daf0d3699d7382b650b81e719` explicitly say the respective contracts accepted local-only evidence, with no commits or pushes required for the latter. This establishes a conflict in evaluation expectations; it does not independently verify the underlying task artifacts.

Additional September 10 run `airdrop_e708a2f5-7cb5-4a18-a21c-a77385aaa063` had retention 88, daily amount 450 PFT, and alignment `2230/70000`, rendering 3/100. A separate query confirmed those 2,230 PFT came from seven earlier completed runs. Its explanation uses lifetime recipient metrics to justify valuation. Run `airdrop_63c8e4b5-cbc2-415f-a64e-e0264ac11b96` instead states that all-time history is outside the lookback evidence.

## Repair direction

Separate contributor assessment from the payout-to-maximum ratio in the product, correct the completed-window timing and payout-status semantics, and preserve task-specific evidence requirements in the scorer input. Establish an explicit calibration rubric before changing economic amounts or mapping retention scores into payouts. No such changes were made during this investigation.
