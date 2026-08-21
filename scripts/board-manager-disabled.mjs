#!/usr/bin/env node

console.log(JSON.stringify({
  event: "board_manager_disabled",
  reason: "Legacy Board Manager action loop is retired. Use hive-board-secretary-worker for advisory Project Status memos.",
  replacement: "npm run hive-board-secretary-worker",
}, null, 2));

setInterval(() => {}, 60 * 60 * 1000);
