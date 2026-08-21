#!/usr/bin/env node
import { migrateDatabase } from "../server/db/migrate.js";
import { startProfileNftRenderWorker } from "../server/profile-nft-render-worker.js";

process.env.TASKNODE_PROCESS_ROLE = "worker:nft-renderer";
await migrateDatabase();
startProfileNftRenderWorker();
console.log("profile_nft_render_worker_started");
await new Promise(() => {});
