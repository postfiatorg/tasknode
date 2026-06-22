```json
{
  "disposition": "verified",
  "recommendedAction": "keep_reward",
  "recommendedRewardPft": 35000,
  "integritySignals": [
    "external_delivery_self_attested"
  ],
  "archival": {
    "archive": true,
    "instructions": "Archive the input evidence packet, generated Orc prompt, original Orc response, parsed five-field JSON, cited CIDs, cited tx hashes, and this reviewer note under the Orc review ledger for the task."
  },
  "notes": "The packet demonstrates the requested formatting layer: a standard Task Node evidence packet is normalized into an Orc review prompt, and the Orc response is parsed into the stable taskGrade/rewardRecommendation/flagIndicators/archivalInstructions/reviewerNotes JSON contract. The external delivery claim is self-attested in this fixture, so preserve that flag for audit."
}
```
