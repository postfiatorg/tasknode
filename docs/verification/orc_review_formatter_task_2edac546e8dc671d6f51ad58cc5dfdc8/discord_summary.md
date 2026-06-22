Orc review formatter demo for task_orc_review_formatter_demo:
- Input: normalized Network Task evidence packet (1 submission event(s), 7 CID(s), 6 tx hash(es)).
- Prompt: generated orc_review_formatter_v1 Orc review prompt with packet JSON embedded for review.
- Parsed JSON: grade=pass; reward=keep_reward: 35000 PFT; flags=external_delivery_self_attested.
- Archive: Archive the input evidence packet, generated Orc prompt, original Orc response, parsed five-field JSON, cited CIDs, cited tx hashes, and this reviewer note under the Orc review ledger for the task.
- Notes: The packet demonstrates the requested formatting layer: a standard Task Node evidence packet is normalized into an Orc review prompt, and the Orc response is parsed into the stable taskGrade/rewardRecommendation/flagIndicators/archivalInstructions/reviewerNotes JSON contract. The external delivery claim is self-attested in this fixture, so preserve that flag for audit.
