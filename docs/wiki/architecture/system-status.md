# System Status

This page is the live audit view for scheduled and background Task Node systems.
It groups the queues, workers, and RPC dependencies that can make the app look
healthy while work is not actually moving.

The status rows are read-only. They do not resume workers, repair queues,
advance tasks, or change Board Manager scheduler state.

Operator repair instructions live in `Architecture -> System Status Runbooks`.
That runbook page defines green, amber, and red for every row rendered here.

## Categories

- Hive and Board Agents: Board Manager, Hive Secretary, active project planning,
  and Board Manager secretary packets.
- Task Systems: Network Task generation, task offer generation, and task review
  or reward work.
- PFTL and RPCs: hot wallet sync, archive sync, websocket watcher, reducer,
  retention, current PFTL RPC/WSS, history RPC/WSS, and Ethereum deposit RPC.
- Memory, Profiles, and Airdrops: turn memory, deep memory, Network Task
  routing profiles, and daily airdrop scoring or issuance.

## Status Rules

Red means the row is paused, stale beyond its expected cadence, has recent failed
work, has a stale active queue, or has no required configuration. Amber means it
is lagging, has recent failed records that need review, or has stale partial
work. Grey means disabled or no durable status source is available. Green means
the latest observed state is current. Historical terminal failures can remain in
the counts for audit without keeping the row amber forever.
